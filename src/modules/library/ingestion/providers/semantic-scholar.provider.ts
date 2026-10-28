import { Injectable, Optional } from '@nestjs/common';
import {
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  cleanBibliographicText,
  cleanAbstractText,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizePageRange,
  parseCreatorString,
  AcademicHttpClient,
  LibraryConfigService,
  libraryConfig,
} from '@/modules/library/core';
import { getAcademicUserAgent } from '@/modules/library/core/constants/academic-client.constants';
import { DomainRateLimiterService } from '@/modules/library/ingestion/services/domain-rate-limiter.service';
import { AbstractAcademicProvider } from './abstract-academic.provider';

/**
 * Semantic Scholar Graph API Provider.
 *
 * Provides access to 200M+ academic papers with AI-generated TLDR summaries,
 * citation metrics (including influential citations), and title semantic search fallback.
 * Operates with 0đ cost on the public open access tier.
 */
@Injectable()
export class SemanticScholarProvider extends AbstractAcademicProvider {
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
    @Optional() private readonly rateLimiter?: DomainRateLimiterService,
    httpClient?: AcademicHttpClient,
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
      'User-Agent': getAcademicUserAgent('SemanticScholar'),
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
