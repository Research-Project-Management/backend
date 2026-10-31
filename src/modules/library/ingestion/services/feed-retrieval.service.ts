import {
  Injectable,
  Logger,
  Optional,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  SsrfGuardService,
  ExternalProviderException,
  readSafeResponseText,
  parseCreatorString,
  getAcademicUserAgent,
  AcademicHttpClient,
} from '@/modules/library/core';
import {
  parseAcademicFeedXml,
  ParsedAcademicFeed,
} from '@/modules/library/ingestion/parsers/rss-atom-feed.parser';
import {
  FeedsRepository,
  type CachedFeedWithItems,
} from '@/modules/library/ingestion/repositories/feeds.repository';
import { CrossRefProvider } from '@/modules/library/ingestion/providers/crossref.provider';

export function redactFeedUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return rawUrl.replace(/\/\/[^/@]+@/, '//').split(/[?#]/)[0];
  }
}

@Injectable()
export class FeedRetrievalService {
  private readonly logger = new Logger(FeedRetrievalService.name);
  private readonly inflightFeedRequests = new Map<
    string,
    Promise<ParsedAcademicFeed>
  >();

  constructor(
    @Optional() private readonly feedsRepo?: FeedsRepository,
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
    @Optional() private readonly crossRefProvider?: CrossRefProvider,
    @Optional() private readonly httpClient?: AcademicHttpClient,
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
    userId?: string,
  ): Promise<ParsedAcademicFeed> {
    if (!feedUrl || typeof feedUrl !== 'string') {
      throw new BadRequestException('A valid feed URL is required');
    }
    const trimmed = feedUrl.trim();

    if (this.feedsRepo?.isAvailable) {
      try {
        const cachedFeed = await this.feedsRepo.findFeedWithRecentItemsByUrl(
          trimmed,
          100,
        );

        // Centralized 1-IP SaaS Protection:
        // Academic journals/preprints update 1-4 times/day.
        // Normal reads serve from the shared DB pool for up to 120 minutes (2 hours).
        // Even explicit user "Refresh" requests enforce a strict 30-minute server-wide cooldown
        // per unique feed URL so N users clicking refresh never trigger outbound IP rate limits.
        const cooldownMinutes = forceRefresh ? 30 : 120;
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
              `User requested refresh for "${redactFeedUrl(trimmed)}", serving virtualized snapshot from shared DB pool (last fetched at ${cachedFeed.lastFetchedAt.toISOString()}) to protect server IP.`,
            );
          }
          const mapped = this.feedsRepo.mapCachedFeedToParsedFeed(cachedFeed);
          return this.hydrateReadStates(mapped, userId);
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Could not read feed from DB: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const existingPromise = this.inflightFeedRequests.get(trimmed);
    if (existingPromise) {
      const res = await existingPromise;
      return this.hydrateReadStates(res, userId);
    }

    const fetchPromise = this.executeFetchAndPersistFeed(trimmed);
    this.inflightFeedRequests.set(trimmed, fetchPromise);

    try {
      const res = await fetchPromise;
      return this.hydrateReadStates(res, userId);
    } finally {
      this.inflightFeedRequests.delete(trimmed);
    }
  }

  private async hydrateReadStates(
    feed: ParsedAcademicFeed,
    userId?: string,
  ): Promise<ParsedAcademicFeed> {
    if (
      !userId ||
      !this.feedsRepo?.findReadItemIdsForUser ||
      !Array.isArray(feed.entries) ||
      feed.entries.length === 0
    ) {
      return feed;
    }
    try {
      const readSet = await this.feedsRepo.findReadItemIdsForUser(
        userId,
        feed.entries.map((e) => e.id).filter(Boolean),
      );
      return {
        ...feed,
        entries: feed.entries.map((e) => ({
          ...e,
          isRead: readSet.has(e.id),
        })),
      };
    } catch {
      return feed;
    }
  }

  private async executeFetchAndPersistFeed(
    trimmed: string,
  ): Promise<ParsedAcademicFeed> {
    let existingFeedRecord: CachedFeedWithItems | null = null;
    if (this.feedsRepo?.isAvailable) {
      try {
        existingFeedRecord = await this.feedsRepo.findFeedWithRecentItemsByUrl(
          trimmed,
          50,
        );
      } catch {
        // ignore db lookup failure
      }
    }

    const headers: Record<string, string> = {
      'User-Agent': getAcademicUserAgent('FeedReader'),
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
      const guard = this.ssrfGuard ?? new SsrfGuardService();
      response = await guard.safeFetch(trimmed, {
        method: 'GET',
        headers,
      });
    } catch (err: unknown) {
      if (
        err instanceof BadRequestException ||
        err instanceof ForbiddenException ||
        (err instanceof Error &&
          (err.message.includes('SSRF Protection') ||
            err.message.includes('SSRF')))
      ) {
        throw err;
      }
      this.logger.warn(
        `Direct fetch failed for feed "${redactFeedUrl(trimmed)}": ${err instanceof Error ? err.message : String(err)}. Attempting search fallback...`,
      );
      return this.fallbackSearchFeed(trimmed);
    }

    if (
      response.status === 304 &&
      existingFeedRecord &&
      existingFeedRecord.items?.length > 0 &&
      this.feedsRepo
    ) {
      this.logger.log(
        `Feed "${redactFeedUrl(trimmed)}" returned 304 Not Modified. Reusing existing articles.`,
      );
      await this.feedsRepo.markFeedPollSuccess(existingFeedRecord.id, 304);
      return this.feedsRepo.mapCachedFeedToParsedFeed(existingFeedRecord);
    }

    if (!response.ok || response.status === 403 || response.status === 503) {
      this.logger.warn(
        `Feed returned HTTP ${response.status} (likely Cloudflare / Bot Protection) for "${redactFeedUrl(trimmed)}". Initiating academic search fallback...`,
      );
      return this.fallbackSearchFeed(trimmed);
    }

    const xml = await readSafeResponseText(response);
    if (
      xml.includes('<!DOCTYPE html') ||
      xml.includes('challenge-running') ||
      xml.includes('cf-browser-verification')
    ) {
      this.logger.warn(
        `Feed URL "${redactFeedUrl(trimmed)}" returned HTML Cloudflare challenge page. Initiating academic search fallback...`,
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
    if (this.feedsRepo) {
      try {
        const persisted = await this.feedsRepo.persistFetchedFeedAndItems({
          feedUrl: trimmed,
          parsed: parsedFeed,
          etag: etagHeader,
          lastModified: lastModifiedHeader,
        });
        if (persisted?.items && persisted.items.length > 0) {
          const idByGuid = new Map<string, string>();
          for (const item of persisted.items) {
            if (item.guid && item.id) {
              idByGuid.set(item.guid, item.id);
            }
          }
          parsedFeed.entries = parsedFeed.entries.map((e, idx) => {
            const guid = (
              e.doi ||
              e.arxivId ||
              e.url ||
              e.id ||
              e.title ||
              ''
            ).trim();
            const matchedId =
              (guid ? idByGuid.get(guid) : undefined) ||
              (persisted.items.length === parsedFeed.entries.length
                ? persisted.items[idx]?.id
                : undefined);
            return {
              ...e,
              id: matchedId || e.id,
            };
          });
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to persist feed to database: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return parsedFeed;
  }

  private async fallbackSearchFeed(
    feedUrl: string,
  ): Promise<ParsedAcademicFeed> {
    const redactedUrl = redactFeedUrl(feedUrl);
    try {
      let filter = '';
      let searchFeedTitle = 'Academic Search Feed';

      if (/biorxiv\.org/i.test(redactedUrl)) {
        filter = 'prefix:10.1101';
        searchFeedTitle = 'bioRxiv Preprints';
      } else if (/medrxiv\.org/i.test(redactedUrl)) {
        filter = 'prefix:10.1101';
        searchFeedTitle = 'medRxiv Preprints';
      } else if (/mdpi\.com/i.test(redactedUrl)) {
        filter = 'prefix:10.3390';
        searchFeedTitle = 'MDPI Open Access';
      } else {
        try {
          const parsedUrl = new URL(redactedUrl);
          const domain = parsedUrl.hostname.replace(/^www\./, '');
          searchFeedTitle = `${domain} Feed`;
        } catch {
          searchFeedTitle = 'Academic Feed';
        }
      }

      const provider =
        this.crossRefProvider ?? new CrossRefProvider(this.httpClient);
      const items = await provider.searchRecentWorks(
        {
          ...(filter ? { filter } : { query: redactedUrl }),
          rows: 30,
        },
        AbortSignal.timeout(15000),
      );
      if (!Array.isArray(items) || items.length === 0) {
        throw new ExternalProviderException(
          'No articles found in fallback academic registry',
        );
      }

      const entries = items.map(
        (
          item: {
            title?: string | string[];
            DOI?: string;
            'container-title'?: string | string[];
            author?: Array<{ given?: string; family?: string; name?: string }>;
            published?: { 'date-parts'?: number[][] };
            created?: { 'date-parts'?: number[][] };
            URL?: string;
            link?: Array<{ 'content-type'?: string; URL?: string }>;
            abstract?: string;
            volume?: string;
            issue?: string;
            page?: string;
            subject?: string[];
            license?: Array<{ URL?: string }>;
          },
          idx: number,
        ) => {
          const rawTitle = Array.isArray(item.title)
            ? item.title[0]
            : item.title || 'Untitled Article';
          const doi = item.DOI || undefined;
          const journal = Array.isArray(item['container-title'])
            ? item['container-title'][0]
            : item['container-title'] || searchFeedTitle;
          const authors = Array.isArray(item.author)
            ? item.author.map(
                (a) =>
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
              item.link?.find((l) => l['content-type'] === 'application/pdf')
                ?.URL || undefined,
            doi,
            authors,
            creators: authors.map((name: string, cIdx: number) =>
              parseCreatorString(name, cIdx, 'author'),
            ),
            abstract:
              item.abstract?.replace(/<[^>]+>/g, '').trim() || undefined,
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
        },
      );

      return {
        format: 'rss2',
        feedTitle: searchFeedTitle,
        feedUrl,
        updatedAt: new Date().toISOString(),
        entries,
      };
    } catch (err: unknown) {
      this.logger.error(
        `Academic search fallback failed for ${redactedUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException(
        `Failed to fetch feed and academic search fallback was unable to retrieve articles: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
