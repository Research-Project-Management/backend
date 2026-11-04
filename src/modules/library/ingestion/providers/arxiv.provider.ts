import { Injectable, Optional } from '@nestjs/common';
import { MetadataRequest, ProviderCapability, ProviderName, ProviderResult } from '@/modules/library/ingestion/types/metadata.types';
import { normalizeArxivId, normalizeDoi, cleanBibliographicText, cleanAbstractText, cleanCommentText, decodeHtmlEntities, normalizeTags, parseCreatorString, HttpClient, LibraryConfigService, libraryConfig, getUserAgent, normalizePageRange } from '@/modules/library/core';
import { BaseMetadataProvider } from './base-metadata.provider';

@Injectable()
export class ArxivProvider extends BaseMetadataProvider {
  readonly id: ProviderName = 'arXiv';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['ARXIV'],
    isAuthoritative: true,
    timeoutMs: 4500,
    maxConcurrency: 2,
  };

  constructor(
    @Optional() httpClient?: HttpClient,
    @Optional() private readonly configService?: LibraryConfigService,
  ) {
    super(httpClient);
  }

  private get baseUrl(): string {
    return (
      this.configService?.providers.arxivBaseUrl ??
      libraryConfig().providers.arxivBaseUrl
    );
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanId = normalizeArxivId(request.query) ?? request.query.trim();
    if (!cleanId) return null;

    const url = `${this.baseUrl}?id_list=${encodeURIComponent(cleanId)}&max_results=1`;

    const headers = {
      'User-Agent': getUserAgent('Arxiv'),
      Accept: 'application/atom+xml, application/xml, text/xml',
    };

    const xmlText = await this.fetchTextWithResilience(
      url,
      signal,
      headers,
      `id: ${cleanId}`,
    );
    if (!xmlText) return null;

    return this.parseAtomXml(xmlText, cleanId);
  }

  private parseAtomXml(xml: string, rawQueryId: string): ProviderResult | null {
    const cleanId = normalizeArxivId(rawQueryId) ?? rawQueryId.trim();
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
    if (!entryMatch) return null;

    const entry = entryMatch[1];

    if (entry.includes('<title>Error</title>')) return null;

    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch
      ? cleanBibliographicText(decodeHtmlEntities(titleMatch[1])) || undefined
      : undefined;

    const authors: string[] = [];
    const authorMatches = entry.matchAll(
      /<author>\s*<name>([\s\S]*?)<\/name>/gi,
    );
    for (const match of authorMatches) {
      if (match[1]) {
        const cleanName = decodeHtmlEntities(match[1].trim());
        if (cleanName) {
          authors.push(cleanName);
        }
      }
    }

    let year: number | null = null;
    let publicationDate: string | undefined;
    const publishedMatch =
      entry.match(/<published>([\s\S]*?)<\/published>/i) ||
      entry.match(/<updated>([\s\S]*?)<\/updated>/i);
    if (publishedMatch) {
      const rawPublished = publishedMatch[1].trim();
      const dateOnly = rawPublished.match(/^(\d{4}-\d{2}-\d{2})/);
      publicationDate = dateOnly ? dateOnly[1] : rawPublished;
      const yearMatch = publicationDate.match(/^(\d{4})/);
      if (yearMatch) year = Number(yearMatch[1]);
    }

    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/i);
    const abstract = summaryMatch
      ? cleanAbstractText(summaryMatch[1])
      : undefined;

    const rawCategories = Array.from(
      entry.matchAll(/<category[^>]*term=["']([^"']+)["'][^>]*>/gi),
      (match) => decodeHtmlEntities(match[1].trim()),
    ).filter(Boolean);

    const primaryCatMatch = entry.match(
      /<arxiv:primary_category[^>]*term=["']([^"']+)["'][^>]*>/i,
    );
    const primaryCategory = primaryCatMatch
      ? decodeHtmlEntities(primaryCatMatch[1].trim())
      : undefined;

    const keywords = normalizeTags(rawCategories);

    const canonicalArxivIdentifier =
      normalizeArxivId(cleanId, { stripVersion: true }) ??
      cleanId.replace(/v\d+$/i, '');
    const arxivDoi = cleanId
      ? `10.48550/arXiv.${canonicalArxivIdentifier}`
      : undefined;
    let publishedDoi: string | undefined;
    const doiMatchResult = entry.match(
      /<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i,
    );
    if (doiMatchResult) {
      publishedDoi = normalizeDoi(decodeHtmlEntities(doiMatchResult[1]));
    }
    const doi = arxivDoi || publishedDoi;

    let journal: string | undefined;
    const journalMatch = entry.match(
      /<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/i,
    );
    if (journalMatch) {
      journal = cleanBibliographicText(decodeHtmlEntities(journalMatch[1]));
    }

    let comment: string | undefined;
    const commentMatch = entry.match(
      /<arxiv:comment[^>]*>([\s\S]*?)<\/arxiv:comment>/i,
    );
    if (commentMatch) {
      comment = cleanCommentText(decodeHtmlEntities(commentMatch[1]));
    }

    let rights: string | undefined;
    const licenseLinkMatch =
      entry.match(
        /<link[^>]*title=["']license["'][^>]*href=["']([^"']+)["'][^>]*>/i,
      ) ||
      entry.match(
        /<link[^>]*href=["']([^"']+)["'][^>]*title=["']license["'][^>]*>/i,
      );
    if (licenseLinkMatch && licenseLinkMatch[1]) {
      const rawLicense = licenseLinkMatch[1].trim();
      if (rawLicense.includes('licenses/by/4.0')) {
        rights = 'CC BY 4.0';
      } else if (rawLicense.includes('licenses/by-sa/4.0')) {
        rights = 'CC BY-SA 4.0';
      } else if (rawLicense.includes('licenses/by-nc-sa/4.0')) {
        rights = 'CC BY-NC-SA 4.0';
      } else if (rawLicense.includes('licenses/by-nc-nd/4.0')) {
        rights = 'CC BY-NC-ND 4.0';
      } else if (rawLicense.includes('nonexclusive-distrib')) {
        rights = 'arXiv.org perpetual non-exclusive license';
      } else if (rawLicense.includes('publicdomain/zero/1.0')) {
        rights = 'CC0 1.0';
      } else {
        rights = rawLicense;
      }
    }

    const canonicalArxivId = cleanId.replace(/v\d+$/i, '');
    const versionMatch = cleanId.match(/v(\d+)$/i);
    const versionNumber = versionMatch ? `v${versionMatch[1]}` : undefined;

    // Legacy archive IDs containing '/' do not append [primaryCategory]
    const arxivExtraLine = canonicalArxivId.includes('/')
      ? `arXiv:${canonicalArxivId}`
      : `arXiv:${canonicalArxivId}${primaryCategory ? ` [${primaryCategory}]` : ''}`;
    const extraLines = [arxivExtraLine];
    if (versionMatch) {
      extraLines.push(`version: ${versionMatch[1]}`);
    }
    if (journal) extraLines.push(`Journal reference: ${journal}`);
    if (publishedDoi) extraLines.push(`Related DOI: ${publishedDoi}`);
    const extra = extraLines.join('\n');

    const pdfUrl = `https://arxiv.org/pdf/${cleanId}.pdf`;
    const canonicalUrl = `https://arxiv.org/abs/${cleanId}`;

    const creators = authors.map((authorName, authorIndex) =>
      parseCreatorString(authorName, authorIndex, 'author'),
    );

    return this.buildProviderResult({
      identifier: cleanId,
      confidenceScore: 0.95,
      rawPayload: xml,
      retrievalMethod: 'api',
      sourceUrl: canonicalUrl,
      canonicalId: `arxiv:${cleanId}`,
      isOpenAccess: true,
      openAccessPdfUrl: pdfUrl,
      metadata: {
        arxivId: cleanId,
        doi,
        title,
        authors,
        creators,
        year,
        publicationDate,
        date: publicationDate,
        publisher: 'arXiv',
        publicationTitle: journal,
        genre: 'Preprint',
        versionNumber,
        abstract,
        archive: 'arXiv',
        repository: 'arXiv',
        archiveId: `arXiv:${canonicalArxivId}`,
        libraryCatalog: 'arXiv.org',
        callNumber: undefined,
        rights,
        license: rights,
        extra,
        notes: comment
          ? [{ content: `Comment: ${comment}`, source: 'arXiv' }]
          : undefined,
        keywords: keywords.length > 0 ? keywords : undefined,
        tags: keywords.length > 0 ? keywords : undefined,
        itemType: 'preprint',
        url: canonicalUrl,
        openAccessPdfUrl: pdfUrl,
        extraFields: {
          repository: 'arXiv',
          archiveId: cleanId,
          ...(versionNumber ? { versionNumber } : {}),
          ...(primaryCategory ? { primaryCategory } : {}),
          ...(rights ? { rights } : {}),
          ...(journal ? { journalRef: journal } : {}),
          ...(publishedDoi ? { publishedDoi } : {}),
        },
      },
    });
  }
}

/**
 * DBLP Computer Science Bibliography Provider.
 *
 * Gold standard open bibliographic database for computer science, AI, and software engineering.
 * Fast, open API with zero recurring cost and authoritative proceedings indexing for
 * NeurIPS, ICML, ICLR, CVPR, ICCV, ECCV, ACL, EMNLP, IEEE, and ACM conferences.
 */
@Injectable()
export class DblpProvider extends BaseMetadataProvider {
  readonly id: ProviderName = 'DBLP';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI', 'TITLE'],
    isAuthoritative: false,
    timeoutMs: 5000,
    maxConcurrency: 2,
  };

  constructor(
    httpClient?: HttpClient,
    @Optional() private readonly configService?: LibraryConfigService,
  ) {
    super(httpClient);
  }

  private get baseUrl(): string {
    return (
      this.configService?.providers.dblpBaseUrl ??
      libraryConfig().providers.dblpBaseUrl
    );
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const rawQuery = request.query?.trim();
    if (!rawQuery) return null;

    const cleanDoi = normalizeDoi(rawQuery);
    const isDoiQuery = Boolean(cleanDoi) || request.queryType === 'DOI';

    const searchQuery = isDoiQuery && cleanDoi ? `doi:${cleanDoi}` : rawQuery;
    const url = `${this.baseUrl}?q=${encodeURIComponent(searchQuery)}&format=json&h=3`;

    const headers = {
      'User-Agent': getUserAgent('Dblp'),
      Accept: 'application/json, text/json',
    };

    const payload = await this.fetchJsonWithResilience<Record<string, unknown>>(
      url,
      signal,
      headers,
      {
        contextLabel: `query: ${searchQuery}`,
        swallowNetworkError: true,
      },
    );
    if (!payload) return null;

    const hits = (
      payload as {
        result?: {
          hits?: {
            hit?:
              | Array<{ info?: Record<string, unknown> }>
              | { info?: Record<string, unknown> };
          };
        };
      }
    )?.result?.hits?.hit;
    if (!hits) return null;

    const hitList = Array.isArray(hits) ? hits : [hits];
    const hitInfos = hitList
      .map((h) => h?.info)
      .filter((info): info is Record<string, unknown> =>
        Boolean(info && info.title),
      );
    if (hitInfos.length === 0) return null;

    let matchedHit: Record<string, unknown> | null = null;
    if (isDoiQuery && cleanDoi) {
      matchedHit =
        hitInfos.find((info) => {
          const hitDoi =
            typeof info.doi === 'string' ? normalizeDoi(info.doi) : undefined;
          return hitDoi && hitDoi.toLowerCase() === cleanDoi.toLowerCase();
        }) ?? null;
    } else {
      const { bestMatch } = this.rankBestTitleCandidate(
        hitInfos,
        rawQuery,
        (info) => {
          const raw =
            typeof info.title === 'string'
              ? info.title
              : (info.title as { text?: string })?.text || '';
          return raw.replace(/\.$/, '').trim();
        },
        undefined,
        {
          authorHint: request.authorHint,
          yearHint: request.yearHint,
          getAuthors: (info) => {
            const rawAuthors = (info.authors as { author?: unknown })?.author;
            if (!rawAuthors) return [];
            const list = Array.isArray(rawAuthors) ? rawAuthors : [rawAuthors];
            return list
              .map((a) =>
                typeof a === 'string'
                  ? a
                  : (a as { text?: string })?.text || '',
              )
              .filter(Boolean);
          },
          getYear: (info) =>
            typeof info.year === 'number' || typeof info.year === 'string'
              ? info.year
              : undefined,
        },
      );
      matchedHit = bestMatch;
    }
    if (!matchedHit) return null;

    return this.mapHitToProviderResult(
      matchedHit,
      isDoiQuery ? cleanDoi || rawQuery : rawQuery,
      isDoiQuery,
    );
  }

  private mapHitToProviderResult(
    info: Record<string, unknown>,
    identifier: string,
    isDoiQuery: boolean,
  ): ProviderResult {
    // 1. Clean Title (DBLP titles often end with a dot)
    const rawTitle =
      typeof info.title === 'string'
        ? info.title
        : (info.title as { text?: string })?.text || '';
    const cleanTitle = (cleanBibliographicText(rawTitle) || '')
      .replace(/\.$/, '')
      .trim();

    // 2. Authors
    const rawAuthors = (info.authors as { author?: unknown })?.author;
    const authorNames: string[] = [];
    if (Array.isArray(rawAuthors)) {
      for (const a of rawAuthors) {
        const name = typeof a === 'string' ? a : (a as { text?: string })?.text;
        if (name && typeof name === 'string')
          authorNames.push(name.replace(/\s+\d+$/, '')); // Strip DBLP disambiguation digits (e.g. "John Smith 0001")
      }
    } else if (rawAuthors) {
      const name =
        typeof rawAuthors === 'string'
          ? rawAuthors
          : (rawAuthors as { text?: string })?.text;
      if (name && typeof name === 'string')
        authorNames.push(name.replace(/\s+\d+$/, ''));
    }

    const creators = authorNames.map((a, idx) =>
      parseCreatorString(a, idx, 'author'),
    );

    const toStr = (v: unknown) =>
      typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';

    // 3. Year
    let year: number | undefined;
    if (info.year) {
      const parsedYear = parseInt(toStr(info.year), 10);
      if (!isNaN(parsedYear) && parsedYear >= 1900 && parsedYear <= 2100) {
        year = parsedYear;
      }
    }

    // 4. Item Type & Venue
    const rawType = toStr(info.type).toLowerCase();
    const venue =
      typeof info.venue === 'string' ? info.venue.trim() : undefined;
    const isConference =
      rawType.includes('conference') || rawType.includes('workshop');
    const isBookSection =
      rawType.includes('parts in books or collections') ||
      rawType.includes('book chapter');
    const isThesis =
      rawType.includes('phd') ||
      rawType.includes('master') ||
      rawType.includes('dissertation') ||
      (rawType.includes('books and theses') &&
        /thesis|dissertation|phd|habil/i.test(
          `${venue || ''} ${toStr(info.note)}`,
        ));
    const isBook =
      !isThesis &&
      (rawType.includes('books and theses') ||
        rawType === 'book' ||
        rawType === 'editorship');
    const isPreprint =
      rawType.includes('informal') ||
      rawType.includes('other publications') ||
      rawType.includes('preprint') ||
      /^corr$/i.test(venue || '');

    const itemType = isConference
      ? 'conferencePaper'
      : isBookSection
        ? 'bookSection'
        : isThesis
          ? 'thesis'
          : isBook
            ? 'book'
            : isPreprint
              ? 'preprint'
              : 'journalArticle';
    const doi =
      typeof info.doi === 'string' ? normalizeDoi(info.doi) : undefined;
    const pagesStr = toStr(info.pages);
    const pages = pagesStr ? normalizePageRange(pagesStr) : undefined;
    const volume = toStr(info.volume) || undefined;
    const issue = toStr(info.number) || undefined;
    const url =
      typeof info.ee === 'string'
        ? info.ee
        : typeof info.url === 'string'
          ? info.url
          : undefined;

    return this.buildProviderResult({
      identifier,
      confidenceScore: isDoiQuery ? 0.9 : 0.85,
      rawPayload: { title: cleanTitle, venue, year, doi },
      retrievalMethod: 'api',
      sourceUrl: url,
      canonicalId: doi ? `doi:${doi}` : `dblp:${identifier}`,
      metadata: {
        itemType,
        title: cleanTitle,
        creators: creators,
        authors: authorNames,
        year,
        doi,
        journal: itemType === 'journalArticle' ? venue : undefined,
        publicationTitle: itemType === 'preprint' ? undefined : venue,
        proceedingsTitle: isConference ? venue : undefined,
        conferenceName: isConference ? venue : undefined,
        ...(isBookSection && venue ? { bookTitle: venue } : {}),
        ...(isPreprint ? { repository: venue || 'CoRR' } : {}),
        pages,
        volume,
        issue,
        url,
      },
    });
  }
}
