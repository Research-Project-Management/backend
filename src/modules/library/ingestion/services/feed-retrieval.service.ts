import {
  Injectable,
  Logger,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@/core';
import { SsrfGuardService, ExternalProviderException } from '@/modules/library/core';
import {
  parseAcademicFeedXml,
  ParsedAcademicFeed,
} from '@/modules/library/ingestion/parsers/rss-atom-feed.parser';

@Injectable()
export class FeedRetrievalService {
  private readonly logger = new Logger(FeedRetrievalService.name);
  private readonly inflightFeedRequests = new Map<
    string,
    Promise<ParsedAcademicFeed>
  >();

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
  ) {}

  /**
   * Resilient Academic RSS / Atom Feed Fetcher.
   * 1. Data Pooling & Anti-Spam: Returns cached DB articles on recent lookups
   * 2. Singleflight Pattern: Coalesces parallel requests for the same feed URL into a single fetch
   * 3. HTTP Conditional GET with ETag & If-Modified-Since (saves 100% bandwidth on 304)
   * 4. Upserts parsed entries into shared `feed_items` pool
   */
  async fetchAcademicFeed(
    feedUrl: string,
    forceRefresh = false,
  ): Promise<ParsedAcademicFeed> {
    if (!feedUrl || typeof feedUrl !== 'string') {
      throw new BadRequestException('A valid feed URL is required');
    }
    const trimmed = feedUrl.trim();

    // 1. Check PostgreSQL Database first (Data Pooling & Cooldown Guard)
    if (this.prisma) {
      try {
        const cachedFeed = await this.prisma.feed.findUnique({
          where: { url: trimmed },
          include: {
            items: {
              orderBy: { publishedAt: 'desc' },
              take: 50,
            },
          },
        });

        const cooldownMinutes = forceRefresh ? 3 : 15;
        const cooldownThreshold = new Date(
          Date.now() - cooldownMinutes * 60 * 1000,
        );

        if (
          cachedFeed &&
          cachedFeed.lastFetchedAt &&
          cachedFeed.lastFetchedAt > cooldownThreshold &&
          cachedFeed.items.length > 0
        ) {
          if (forceRefresh) {
            this.logger.log(
              `User requested refresh for "${trimmed}", but feed was refreshed recently (< 3 min). Serving from DB to prevent publisher rate limit.`,
            );
          }
          return {
            format: 'atom',
            feedTitle: cachedFeed.title,
            feedUrl: cachedFeed.url,
            entries: cachedFeed.items.map((it: any) => ({
              id: it.id,
              title: it.title,
              url: it.url,
              pdfUrl: it.pdfUrl || undefined,
              doi: it.doi || undefined,
              arxivId: it.arxivId || undefined,
              primaryCategory: it.primaryCategory || undefined,
              authors: Array.isArray(it.authors)
                ? (it.authors as any[]).map((a) =>
                    typeof a === 'string' ? a : a.name || '',
                  )
                : [],
              creators: Array.isArray(it.authors)
                ? (it.authors as any[]).map((a) => {
                    const name = typeof a === 'string' ? a : a.name || '';
                    return {
                      firstName: '',
                      lastName: name,
                      fullName: name,
                      creatorType: 'author' as const,
                    };
                  })
                : [],
              abstract: it.abstract || undefined,
              publicationTitle: cachedFeed.title,
              publicationDate: it.publishedAt
                ? it.publishedAt.toISOString()
                : undefined,
              year: it.publishedAt
                ? new Date(it.publishedAt).getFullYear()
                : null,
              keywords: it.primaryCategory ? [it.primaryCategory] : [],
              rights: it.license || undefined,
              itemType: it.arxivId ? 'preprint' : 'journalArticle',
            })),
          };
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Could not read feed from DB: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 2. Singleflight: If a request for this URL is already in-flight, await it rather than duplicating
    const existingPromise = this.inflightFeedRequests.get(trimmed);
    if (existingPromise) {
      return existingPromise;
    }

    const fetchPromise = this.executeFetchAndPersistFeed(trimmed);
    this.inflightFeedRequests.set(trimmed, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.inflightFeedRequests.delete(trimmed);
    }
  }

  private async executeFetchAndPersistFeed(
    trimmed: string,
  ): Promise<ParsedAcademicFeed> {
    let existingFeedRecord: any = null;
    if (this.prisma) {
      try {
        existingFeedRecord = await this.prisma.feed.findUnique({
          where: { url: trimmed },
          include: {
            items: {
              orderBy: { publishedAt: 'desc' },
              take: 50,
            },
          },
        });
      } catch {
        // ignore db lookup failure
      }
    }

    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 (compatible; FluxAcademicReader/1.0; +https://zotero.org)',
      Accept:
        'application/atom+xml, application/rss+xml, application/rdf+xml, application/xml, text/xml, */*;q=0.8',
    };

    if (existingFeedRecord?.etag) {
      headers['If-None-Match'] = existingFeedRecord.etag;
    }
    if (existingFeedRecord?.lastModified) {
      headers['If-Modified-Since'] = existingFeedRecord.lastModified;
    }

    let response: Response;
    try {
      if (this.ssrfGuard) {
        response = await this.ssrfGuard.safeFetch(trimmed, {
          method: 'GET',
          headers,
        });
      } else {
        response = await fetch(trimmed, { method: 'GET', headers });
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Direct fetch failed for feed "${trimmed}": ${err instanceof Error ? err.message : String(err)}. Attempting search fallback...`,
      );
      return this.fallbackSearchFeed(trimmed);
    }

    if (
      response.status === 304 &&
      existingFeedRecord &&
      existingFeedRecord.items?.length > 0
    ) {
      this.logger.log(
        `Feed "${trimmed}" returned 304 Not Modified. Reusing existing articles.`,
      );
      if (this.prisma) {
        await this.prisma.feed
          .update({
            where: { id: existingFeedRecord.id },
            data: { lastFetchedAt: new Date(), lastStatus: 304, errorCount: 0 },
          })
          .catch(() => {});
      }
      return {
        format: 'atom',
        feedTitle: existingFeedRecord.title,
        feedUrl: existingFeedRecord.url,
        entries: existingFeedRecord.items.map((it: any) => ({
          id: it.id,
          title: it.title,
          url: it.url,
          pdfUrl: it.pdfUrl || undefined,
          doi: it.doi || undefined,
          arxivId: it.arxivId || undefined,
          primaryCategory: it.primaryCategory || undefined,
          authors: Array.isArray(it.authors)
            ? (it.authors as any[]).map((a) =>
                typeof a === 'string' ? a : a.name || '',
              )
            : [],
          creators: Array.isArray(it.authors)
            ? (it.authors as any[]).map((a) => {
                const name = typeof a === 'string' ? a : a.name || '';
                return {
                  firstName: '',
                  lastName: name,
                  fullName: name,
                  creatorType: 'author' as const,
                };
              })
            : [],
          abstract: it.abstract || undefined,
          publicationTitle: existingFeedRecord.title,
          publicationDate: it.publishedAt
            ? it.publishedAt.toISOString()
            : undefined,
          year: it.publishedAt ? new Date(it.publishedAt).getFullYear() : null,
          keywords: it.primaryCategory ? [it.primaryCategory] : [],
          rights: it.license || undefined,
          itemType: it.arxivId ? 'preprint' : 'journalArticle',
        })),
      };
    }

    if (!response.ok || response.status === 403 || response.status === 503) {
      this.logger.warn(
        `Feed returned HTTP ${response.status} (likely Cloudflare / Bot Protection) for "${trimmed}". Initiating academic search fallback...`,
      );
      return this.fallbackSearchFeed(trimmed);
    }

    const xml = await response.text();
    if (
      xml.includes('<!DOCTYPE html') ||
      xml.includes('challenge-running') ||
      xml.includes('cf-browser-verification')
    ) {
      this.logger.warn(
        `Feed URL "${trimmed}" returned HTML Cloudflare challenge page. Initiating academic search fallback...`,
      );
      return this.fallbackSearchFeed(trimmed);
    }

    const parsed = parseAcademicFeedXml(xml);
    const parsedFeed: ParsedAcademicFeed = {
      ...parsed,
      feedUrl: parsed.feedUrl || trimmed,
    };

    const etagHeader = response.headers.get('etag') || undefined;
    const lastModifiedHeader =
      response.headers.get('last-modified') || undefined;
    this.persistFeedToDatabase(
      trimmed,
      parsedFeed,
      etagHeader,
      lastModifiedHeader,
    ).catch((err) => {
      this.logger.warn(
        `Failed to persist feed to database: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    return parsedFeed;
  }

  private async persistFeedToDatabase(
    feedUrl: string,
    parsed: ParsedAcademicFeed,
    etag?: string,
    lastModified?: string,
  ) {
    if (!this.prisma) return;

    const feed = await this.prisma.feed.upsert({
      where: { url: feedUrl },
      create: {
        url: feedUrl,
        title: parsed.feedTitle || 'Academic Feed',
        siteUrl: undefined,
        description: undefined,
        etag,
        lastModified,
        lastFetchedAt: new Date(),
        lastStatus: 200,
        errorCount: 0,
      },
      update: {
        title: parsed.feedTitle || undefined,
        etag: etag || undefined,
        lastModified: lastModified || undefined,
        lastFetchedAt: new Date(),
        lastStatus: 200,
        errorCount: 0,
      },
    });

    if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) return;

    for (const entry of parsed.entries) {
      const guid = (
        entry.doi ||
        entry.arxivId ||
        entry.url ||
        entry.id ||
        entry.title ||
        ''
      ).trim();
      if (!guid || !entry.title) continue;

      const publishedDate = entry.publicationDate
        ? new Date(entry.publicationDate)
        : new Date();
      const validPublishedAt = isNaN(publishedDate.getTime())
        ? new Date()
        : publishedDate;

      const authorsJson = Array.isArray(entry.authors)
        ? entry.authors.map((a: string) => ({ name: a }))
        : [];

      await this.prisma.feedItem
        .upsert({
          where: {
            feedId_guid: {
              feedId: feed.id,
              guid,
            },
          },
          create: {
            feedId: feed.id,
            guid,
            title: entry.title,
            url: entry.url || feedUrl,
            pdfUrl: entry.pdfUrl,
            doi: entry.doi,
            arxivId: entry.arxivId,
            primaryCategory: entry.primaryCategory,
            authors: authorsJson,
            abstract: entry.abstract,
            license: entry.rights,
            comments: undefined,
            publishedAt: validPublishedAt,
          },
          update: {
            title: entry.title,
            url: entry.url || undefined,
            pdfUrl: entry.pdfUrl || undefined,
            doi: entry.doi || undefined,
            arxivId: entry.arxivId || undefined,
            primaryCategory: entry.primaryCategory || undefined,
            authors: authorsJson,
            abstract: entry.abstract || undefined,
            license: entry.rights || undefined,
          },
        })
        .catch(() => {});
    }
  }

  private async fallbackSearchFeed(
    feedUrl: string,
  ): Promise<ParsedAcademicFeed> {
    try {
      let filter = '';
      let searchFeedTitle = 'Academic Search Feed';

      if (/biorxiv\.org/i.test(feedUrl)) {
        filter = 'prefix:10.1101';
        searchFeedTitle = 'bioRxiv Preprints';
      } else if (/medrxiv\.org/i.test(feedUrl)) {
        filter = 'prefix:10.1101';
        searchFeedTitle = 'medRxiv Preprints';
      } else if (/mdpi\.com/i.test(feedUrl)) {
        filter = 'prefix:10.3390';
        searchFeedTitle = 'MDPI Open Access';
      } else {
        try {
          const parsedUrl = new URL(feedUrl);
          const domain = parsedUrl.hostname.replace(/^www\./, '');
          searchFeedTitle = `${domain} Feed`;
        } catch {
          searchFeedTitle = 'Academic Feed';
        }
      }

      const crossrefUrl = filter
        ? `https://api.crossref.org/works?filter=${filter}&rows=30&sort=published&order=desc`
        : `https://api.crossref.org/works?query=${encodeURIComponent(feedUrl)}&rows=30&sort=published&order=desc`;

      const fallbackRes = await fetch(crossrefUrl, {
        headers: {
          'User-Agent': 'FluxAcademicBot/1.0 (mailto:admin@flux.app)',
          Accept: 'application/json',
        },
      });

      if (!fallbackRes.ok) {
        throw new ExternalProviderException(
          `Academic registry search responded with HTTP ${fallbackRes.status}`,
        );
      }

      const json = await fallbackRes.json();
      const items = json?.message?.items;
      if (!Array.isArray(items) || items.length === 0) {
        throw new ExternalProviderException(
          'No articles found in fallback academic registry',
        );
      }

      const entries = items.map((item: any, idx: number) => {
        const rawTitle = Array.isArray(item.title)
          ? item.title[0]
          : item.title || 'Untitled Article';
        const doi = item.DOI || undefined;
        const journal = Array.isArray(item['container-title'])
          ? item['container-title'][0]
          : item['container-title'] || searchFeedTitle;
        const authors = Array.isArray(item.author)
          ? item.author.map(
              (a: any) =>
                [a.given, a.family].filter(Boolean).join(' ') ||
                a.name ||
                'Author',
            )
          : [];
        const pubDateParts =
          item.published?.['date-parts']?.[0] ||
          item.created?.['date-parts']?.[0];
        const publishedDate = pubDateParts
          ? `${pubDateParts[0]}-${String(pubDateParts[1] || 1).padStart(2, '0')}-${String(pubDateParts[2] || 1).padStart(2, '0')}`
          : undefined;

        return {
          id: doi ? `doi:${doi}` : `search-item-${idx}`,
          title: rawTitle,
          url: item.URL || (doi ? `https://doi.org/${doi}` : undefined),
          pdfUrl:
            item.link?.find((l: any) => l['content-type'] === 'application/pdf')
              ?.URL || (doi ? `https://doi.org/${doi}` : undefined),
          doi,
          authors,
          creators: authors.map((name: string) => ({
            name,
            creatorType: 'author',
          })),
          abstract: item.abstract?.replace(/<[^>]+>/g, '').trim() || undefined,
          publicationTitle: journal,
          volume: item.volume || undefined,
          issue: item.issue || undefined,
          pages: item.page || undefined,
          publicationDate: publishedDate,
          year: pubDateParts ? pubDateParts[0] : undefined,
          keywords: Array.isArray(item.subject) ? item.subject : [],
          rights: item.license?.[0]?.URL || 'Open Access',
          itemType: 'journalArticle' as const,
        };
      });

      return {
        format: 'rss2',
        feedTitle: searchFeedTitle,
        feedUrl,
        updatedAt: new Date().toISOString(),
        entries,
      };
    } catch (err: unknown) {
      this.logger.error(
        `Academic search fallback failed for ${feedUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException(
        `Failed to fetch feed and academic search fallback was unable to retrieve articles: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
