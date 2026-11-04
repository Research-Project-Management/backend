import { Injectable, Optional } from '@nestjs/common';
import { MetadataRequest, ProviderCapability, ProviderName, ProviderResult, MetadataProvider, QueryType } from '@/modules/library/ingestion/types/metadata.types';
import { cleanBibliographicText, cleanAbstractText, normalizeDoi, normalizeArxivId, normalizePmid, normalizePmcid, normalizePageRange, parseCreatorString, HttpClient, LibraryConfigService, libraryConfig, getUserAgent, normalizeIsbn, normalizeTags, getContactEmail } from '@/modules/library/core';
import { BaseMetadataProvider } from './base-metadata.provider';
import { createHash } from 'crypto';
import { ProviderFetchError } from '@/modules/library/ingestion/services/metadata-executor.service';

/**
 * Semantic Scholar Graph API Provider.
 *
 * Provides access to 200M+ academic papers with AI-generated TLDR summaries,
 * citation metrics (including influential citations), and title semantic search fallback.
 * Operates with 0đ cost on the public open access tier.
 */
@Injectable()
export class SemanticScholarProvider extends BaseMetadataProvider {
  readonly id: ProviderName = 'SemanticScholar';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI', 'ARXIV', 'PMID', 'TITLE'],
    isAuthoritative: false,
    timeoutMs: 6000,
    maxConcurrency: 3,
  };

  private readonly FIELDS =
    'title,authors,year,publicationDate,venue,publicationVenue,journal,publicationTypes,abstract,openAccessPdf,citationCount,referenceCount,influentialCitationCount,tldr,externalIds,url';

  constructor(
    httpClient?: HttpClient,
    @Optional() private readonly configService?: LibraryConfigService,
  ) {
    super(httpClient);
  }

  private get baseUrl(): string {
    const base =
      this.configService?.providers.semanticScholarBaseUrl ??
      libraryConfig().providers.semanticScholarBaseUrl;
    return base.endsWith('/paper') ? base : `${base}/paper`;
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const rawQuery = request.query?.trim();
    if (!rawQuery) return null;

    let targetUrl: string;
    let identifier = rawQuery;
    let isSpecificId = false;

    const arxiv = normalizeArxivId(rawQuery, { stripVersion: true });
    const doi = normalizeDoi(rawQuery);
    const pmid = normalizePmid(rawQuery);

    if (arxiv) {
      targetUrl = `${this.baseUrl}/ARXIV:${encodeURIComponent(arxiv)}?fields=${this.FIELDS}`;
      identifier = arxiv;
      isSpecificId = true;
    } else if (doi) {
      targetUrl = `${this.baseUrl}/DOI:${encodeURIComponent(doi)}?fields=${this.FIELDS}`;
      identifier = doi;
      isSpecificId = true;
    } else if (pmid) {
      targetUrl = `${this.baseUrl}/PMID:${encodeURIComponent(pmid)}?fields=${this.FIELDS}`;
      identifier = pmid;
      isSpecificId = true;
    } else {
      targetUrl = `${this.baseUrl}/search?query=${encodeURIComponent(rawQuery)}&limit=5&fields=${this.FIELDS}`;
    }

    const headers = {
      'User-Agent': getUserAgent('SemanticScholar'),
      Accept: 'application/json',
    };

    const payload = await this.fetchJsonWithResilience<Record<string, unknown>>(
      targetUrl,
      signal,
      headers,
      {
        contextLabel: `query: ${identifier}`,
        swallowNetworkError: true,
      },
    );
    if (!payload) return null;

    let paper: Record<string, unknown> | null = null;
    if (isSpecificId) {
      paper = payload;
    } else {
      const candidates = Array.isArray(payload?.data)
        ? (payload.data as Array<Record<string, unknown>>)
        : [];
      const { bestMatch } = this.rankBestTitleCandidate(
        candidates,
        rawQuery,
        (item) => (typeof item.title === 'string' ? item.title : ''),
        undefined,
        {
          authorHint: request.authorHint,
          yearHint: request.yearHint,
          getAuthors: (item) => item.authors,
          getYear: (item) =>
            typeof item.year === 'number' || typeof item.year === 'string'
              ? item.year
              : undefined,
        },
      );
      paper = bestMatch;
    }
    if (!paper || !paper.title) return null;

    return this.mapPaperToProviderResult(paper, identifier, isSpecificId);
  }

  private mapPaperToProviderResult(
    paper: Record<string, unknown>,
    identifier: string,
    isSpecificId: boolean,
  ): ProviderResult {
    const cleanTitle = cleanBibliographicText(
      typeof paper.title === 'string' ? paper.title : '',
    );
    const authorsList = (
      Array.isArray(paper.authors) ? paper.authors : []
    ) as Array<{ name?: string } | string>;
    const authors: string[] = authorsList
      .map((a) => (typeof a === 'string' ? a : a?.name))
      .filter((name: string | undefined): name is string =>
        Boolean(name && typeof name === 'string'),
      );

    const creators = authors.map((a, idx) =>
      parseCreatorString(a, idx, 'author'),
    );

    const publicationDate =
      typeof paper.publicationDate === 'string' && paper.publicationDate.trim()
        ? paper.publicationDate.trim()
        : undefined;

    let year: number | undefined;
    if (typeof paper.year === 'number' || typeof paper.year === 'string') {
      const parsedYear = parseInt(String(paper.year), 10);
      if (!isNaN(parsedYear) && parsedYear >= 1900 && parsedYear <= 2100) {
        year = parsedYear;
      }
    } else if (publicationDate) {
      const m = publicationDate.match(/^(\d{4})/);
      if (m) year = parseInt(m[1], 10);
    }

    const pubVenue = paper.publicationVenue as
      { name?: string; type?: string; issn?: string } | undefined;
    const issn =
      typeof pubVenue?.issn === 'string' && pubVenue.issn.trim()
        ? pubVenue.issn.trim()
        : undefined;
    const journalObj = paper.journal as
      { name?: string; volume?: string; pages?: string } | undefined;
    const rawVenue =
      typeof paper.venue === 'string' && paper.venue.trim()
        ? paper.venue.trim()
        : pubVenue?.name?.trim() || undefined;
    const venue =
      (journalObj?.name && journalObj.name.trim()
        ? journalObj.name.trim()
        : undefined) || rawVenue;
    const volume =
      typeof journalObj?.volume === 'string' && journalObj.volume.trim()
        ? journalObj.volume.trim()
        : undefined;
    const pages =
      typeof journalObj?.pages === 'string' && journalObj.pages.trim()
        ? normalizePageRange(journalObj.pages.trim())
        : undefined;

    const abstract =
      typeof paper.abstract === 'string'
        ? cleanAbstractText(paper.abstract)
        : undefined;
    const externalIds = paper.externalIds as
      Record<string, string | number | undefined> | undefined;
    const doi = externalIds?.DOI
      ? normalizeDoi(String(externalIds.DOI))
      : undefined;
    const arxivId = externalIds?.ArXiv
      ? normalizeArxivId(String(externalIds.ArXiv))
      : undefined;
    const pmid = externalIds?.PubMed
      ? normalizePmid(String(externalIds.PubMed))
      : undefined;
    const pmcid = externalIds?.PubMedCentral
      ? normalizePmcid(String(externalIds.PubMedCentral))
      : undefined;

    const pubTypes = (
      Array.isArray(paper.publicationTypes) ? paper.publicationTypes : []
    ).map((t) => String(t).toLowerCase());
    const venueType = (pubVenue?.type || '').toLowerCase();

    let itemType = 'journalArticle';
    if (pubTypes.includes('booksection')) {
      itemType = 'bookSection';
    } else if (pubTypes.includes('book')) {
      itemType = 'book';
    } else if (pubTypes.includes('conference') || venueType === 'conference') {
      itemType = 'conferencePaper';
    } else if (
      arxivId &&
      (!venue || /^arxiv\b/i.test(venue)) &&
      (!doi || doi.toLowerCase().startsWith('10.48550/arxiv.'))
    ) {
      itemType = 'preprint';
    }

    const proceedingsTitle = itemType === 'conferencePaper' ? venue : undefined;
    const conferenceName =
      itemType === 'conferencePaper'
        ? pubVenue?.name?.trim() || venue
        : undefined;
    const repository = itemType === 'preprint' && arxivId ? 'arXiv' : undefined;
    const archive = arxivId ? 'arXiv' : undefined;
    const archiveId = arxivId ? `arXiv:${arxivId}` : undefined;

    const citationCount =
      typeof paper.citationCount === 'number' && paper.citationCount >= 0
        ? paper.citationCount
        : undefined;
    const referenceCount =
      typeof paper.referenceCount === 'number' && paper.referenceCount >= 0
        ? paper.referenceCount
        : undefined;

    const openAccessPdf = paper.openAccessPdf as { url?: string } | undefined;
    const openAccessUrl = openAccessPdf?.url || undefined;
    const canonicalUrl =
      openAccessUrl ||
      (typeof paper.url === 'string' && paper.url.trim()
        ? paper.url.trim()
        : undefined) ||
      (doi ? `https://doi.org/${doi}` : undefined);

    return this.buildProviderResult({
      identifier,
      confidenceScore: isSpecificId ? 0.92 : 0.85,
      rawPayload: { title: cleanTitle, venue, year, doi, arxivId },
      retrievalMethod: 'api',
      sourceUrl: canonicalUrl,
      canonicalId: doi
        ? `doi:${doi}`
        : arxivId
          ? `arxiv:${arxivId}`
          : `s2:${identifier}`,
      isOpenAccess: Boolean(openAccessUrl),
      openAccessPdfUrl: openAccessUrl,
      metadata: {
        itemType,
        title: cleanTitle,
        creators,
        authors,
        year,
        ...(publicationDate ? { publicationDate, date: publicationDate } : {}),
        doi,
        arxivId,
        pmid,
        ...(pmcid ? { pmcid } : {}),
        ...(issn ? { issn } : {}),
        journal: itemType === 'preprint' ? undefined : venue,
        publicationTitle: itemType === 'preprint' ? undefined : venue,
        ...(proceedingsTitle ? { proceedingsTitle } : {}),
        ...(conferenceName ? { conferenceName } : {}),
        ...(volume ? { volume } : {}),
        ...(pages ? { pages } : {}),
        ...(repository ? { repository } : {}),
        ...(archive ? { archive } : {}),
        ...(archiveId ? { archiveId } : {}),
        ...(citationCount !== undefined ? { citationCount } : {}),
        ...(referenceCount !== undefined ? { referenceCount } : {}),
        ...(openAccessUrl ? { openAccessPdfUrl: openAccessUrl } : {}),
        abstract,
        url: canonicalUrl,
        libraryCatalog: 'Semantic Scholar',
      },
    });
  }
}

@Injectable()
export class OpenLibraryProvider extends BaseMetadataProvider {
  readonly id: ProviderName = 'OpenLibrary';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['ISBN'],
    isAuthoritative: true,
    timeoutMs: 8000,
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
      this.configService?.providers.openLibraryBaseUrl ??
      libraryConfig().providers.openLibraryBaseUrl
    );
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanIsbn = normalizeIsbn(request.query);
    if (!cleanIsbn) return null;

    const bibKey = `ISBN:${cleanIsbn}`;
    const url = `${this.baseUrl}?bibkeys=${encodeURIComponent(bibKey)}&format=json&jscmd=data`;

    const headers = {
      'User-Agent': getUserAgent('OpenLibrary'),
      Accept: 'application/json',
    };

    const payload = await this.fetchJsonWithResilience<
      Record<string, Record<string, unknown>>
    >(url, signal, headers, { contextLabel: `ISBN: ${cleanIsbn}` });
    const item = payload?.[bibKey];
    if (!item) return null;

    return this.transformPayload(item, cleanIsbn);
  }

  private transformPayload(
    item: Record<string, unknown>,
    cleanIsbn: string,
  ): ProviderResult {
    const rawTitle =
      typeof item.title === 'string' && item.title.trim()
        ? item.title.trim()
        : 'Untitled Book';
    const rawSubtitle =
      typeof item.subtitle === 'string' && item.subtitle.trim()
        ? item.subtitle.trim()
        : undefined;
    const title =
      rawSubtitle && !rawTitle.includes(':')
        ? `${rawTitle}: ${rawSubtitle}`
        : rawTitle;
    const shortTitle =
      rawSubtitle && !rawTitle.includes(':') ? rawTitle : undefined;

    const authors: string[] = [];
    if (Array.isArray(item.authors)) {
      for (const a of item.authors) {
        if (
          a &&
          typeof a === 'object' &&
          typeof (a as { name?: string }).name === 'string'
        ) {
          authors.push((a as { name: string }).name.trim());
        }
      }
    }

    let year: number | null = null;
    if (typeof item.publish_date === 'string') {
      const match = item.publish_date.match(/(\d{4})/);
      if (match) year = Number(match[1]);
    }

    let publisher: string | undefined;
    if (Array.isArray(item.publishers) && item.publishers[0]) {
      const firstPub = item.publishers[0] as { name?: string };
      if (typeof firstPub.name === 'string' && firstPub.name.trim()) {
        publisher = firstPub.name.trim();
      }
    }

    let place: string | undefined;
    if (Array.isArray(item.publish_places) && item.publish_places[0]) {
      const firstPlace = item.publish_places[0] as { name?: string } | string;
      if (typeof firstPlace === 'string' && firstPlace.trim()) {
        place = firstPlace.trim();
      } else if (
        firstPlace &&
        typeof firstPlace === 'object' &&
        typeof firstPlace.name === 'string' &&
        firstPlace.name.trim()
      ) {
        place = firstPlace.name.trim();
      }
    }

    const edition =
      typeof item.edition_name === 'string' && item.edition_name.trim()
        ? item.edition_name.trim()
        : undefined;

    const rawSubjects: string[] = [];
    if (Array.isArray(item.subjects)) {
      for (const s of item.subjects.slice(0, 8)) {
        if (typeof s === 'string' && s.trim()) {
          rawSubjects.push(s.trim());
        } else if (
          s &&
          typeof s === 'object' &&
          typeof (s as { name?: string }).name === 'string' &&
          (s as { name: string }).name.trim()
        ) {
          rawSubjects.push((s as { name: string }).name.trim());
        }
      }
    }
    const keywords = normalizeTags(rawSubjects).slice(0, 8);

    const pages =
      typeof item.number_of_pages === 'number' ||
      typeof item.number_of_pages === 'string'
        ? String(item.number_of_pages)
        : undefined;
    const numberOfPages =
      pages && !Number.isNaN(Number(pages)) ? Number(pages) : undefined;

    const rawUrl = typeof item.url === 'string' ? item.url : undefined;
    const canonicalUrl = rawUrl || `https://openlibrary.org/isbn/${cleanIsbn}`;

    const creators = authors.map((name, idx) =>
      parseCreatorString(name, idx, 'author'),
    );

    return this.buildProviderResult({
      identifier: cleanIsbn,
      confidenceScore: 0.95,
      rawPayload: item,
      retrievalMethod: 'api',
      sourceUrl: canonicalUrl,
      canonicalId: `isbn:${cleanIsbn}`,
      isOpenAccess: false,
      metadata: {
        title,
        ...(shortTitle ? { shortTitle } : {}),
        authors,
        creators,
        year,
        isbn: cleanIsbn,
        publisher,
        ...(place ? { place } : {}),
        ...(edition ? { edition } : {}),
        pages,
        ...(pages ? { numPages: pages } : {}),
        ...(numberOfPages ? { numberOfPages } : {}),
        ...(keywords.length > 0 ? { keywords, tags: keywords } : {}),
        itemType: 'book',
        url: canonicalUrl,
        libraryCatalog: 'Open Library',
        extraFields: {
          numPages: pages,
          ...(numberOfPages ? { numberOfPages } : {}),
          isbn: cleanIsbn,
          ...(place ? { place } : {}),
          ...(edition ? { edition } : {}),
        },
      },
    });
  }
}

@Injectable()
export class UnpaywallProvider implements MetadataProvider {
  readonly id: ProviderName = 'Unpaywall';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI'],
    isAuthoritative: false,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  constructor(
    private readonly httpClient: HttpClient,
    @Optional() private readonly configService?: LibraryConfigService,
  ) {}

  private get baseUrl(): string {
    return (
      this.configService?.providers.unpaywallBaseUrl ??
      libraryConfig().providers.unpaywallBaseUrl
    );
  }

  private get email(): string {
    return (
      this.configService?.providers.unpaywallEmail ??
      libraryConfig().providers.unpaywallEmail ??
      getContactEmail()
    );
  }

  supports(input: QueryType | MetadataRequest): boolean {
    const type = typeof input === 'string' ? input : input?.queryType;
    return type ? this.capabilities.queryTypes.includes(type) : false;
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanDoi = normalizeDoi(request.query);
    if (!cleanDoi) return null;

    const url = `${this.baseUrl}/${encodeURIComponent(cleanDoi)}?email=${encodeURIComponent(this.email)}`;

    const headers = {
      'User-Agent': getUserAgent('Unpaywall'),
      Accept: 'application/json',
    };

    const { response } = await this.httpClient.request(url, {
      headers,
      signal,
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : undefined;
      throw new ProviderFetchError(
        `Unpaywall API HTTP ${response.status} for DOI: ${cleanDoi}`,
        response.status,
        retryAfterMs,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse Unpaywall JSON for DOI: ${cleanDoi}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    const payload = json as {
      is_oa?: boolean;
      title?: string;
      journal_name?: string;
      best_oa_location?: {
        url_for_pdf?: string;
        url?: string;
      };
    } | null;

    const isOa = Boolean(payload?.is_oa);
    const bestOaLocation = payload?.best_oa_location;
    // Strict Full-text resolver: Only treat as openAccessPdfUrl if it is explicitly a direct PDF URL
    // or a non-DOI URL (to avoid polluting openAccessPdfUrl with DOI landing page redirect loops)
    const rawOaCandidate =
      bestOaLocation?.url_for_pdf || bestOaLocation?.url || undefined;
    const isDirectPdfUrl = Boolean(
      bestOaLocation?.url_for_pdf ||
      (rawOaCandidate && /\.pdf(?:$|\?|#)/i.test(rawOaCandidate)) ||
      (rawOaCandidate &&
        !/^https?:\/\/(?:dx\.)?doi\.org\//i.test(rawOaCandidate)),
    );
    const pdfUrl = isDirectPdfUrl ? rawOaCandidate : undefined;

    const hasMetadata = Boolean(payload?.title || pdfUrl);
    if (!hasMetadata) return null;

    const rawVersion = createHash('md5')
      .update(JSON.stringify(payload))
      .digest('hex');

    return {
      provider: this.id,
      metadata: {
        doi: cleanDoi,
        title: typeof payload?.title === 'string' ? payload.title : undefined,
        journal:
          typeof payload?.journal_name === 'string'
            ? payload.journal_name
            : undefined,
        openAccessPdfUrl: pdfUrl,
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId: `doi:${cleanDoi}`,
          canonicalUrl: `https://doi.org/${cleanDoi}`,
          confidenceScore: 0.99,
          rawSnapshotHash: rawVersion,
          isOpenAccess: isOa,
          openAccessPdfUrl: pdfUrl,
        },
      },
      confidence: 0.99,
      identifier: cleanDoi,
      fetchedAt: new Date().toISOString(),
      rawVersion,
    };
  }
}
