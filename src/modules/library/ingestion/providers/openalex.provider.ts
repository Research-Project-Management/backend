import { Injectable, Optional } from '@nestjs/common';
import {
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  cleanAbstractText,
  cleanBibliographicText,
  TITLE_MATCH_THRESHOLD,
  AcademicHttpClient,
  LibraryConfigService,
  libraryConfig,
  normalizePageRange,
  parseCreatorString,
} from '@/modules/library/core';
import { ProviderFetchError } from '@/modules/library/ingestion/services/metadata-executor.service';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import { AbstractAcademicProvider } from './abstract-academic.provider';

@Injectable()
export class OpenAlexProvider extends AbstractAcademicProvider {
  readonly id: ProviderName = 'OpenAlex';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI', 'TITLE', 'ARXIV', 'PMID'],
    isAuthoritative: false,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  private readonly BASE_URL = 'https://api.openalex.org/works';

  constructor(
    @Optional() httpClient?: AcademicHttpClient,
    @Optional() private readonly configService?: LibraryConfigService,
  ) {
    super(httpClient);
  }

  private get mailto(): string {
    return (
      this.configService?.providers.openAlexEmail ??
      libraryConfig().providers.openAlexEmail ??
      'contact@flux.academic'
    );
  }

  private get apiKey(): string | undefined {
    return (
      this.configService?.providers.openAlexApiKey ??
      libraryConfig().providers.openAlexApiKey
    );
  }

  private async executeFetch(
    url: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers = {
      'User-Agent': `FluxResearchPlatform/1.0 (mailto:${this.mailto}; https://flux.study)`,
      Accept: 'application/json',
    };
    return this.executeHttpFetch(url, signal, headers);
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const { query } = request;
    const cleanArxiv = normalizeArxivId(query, { stripVersion: true });
    if (cleanArxiv) {
      return this.fetchByArxiv(cleanArxiv, signal);
    }

    const cleanDoi = normalizeDoi(query);

    if (cleanDoi) {
      return this.fetchByDoi(cleanDoi, signal);
    }

    const cleanPmid = normalizePmid(query);
    if (cleanPmid) {
      return this.fetchByPmid(cleanPmid, signal);
    }

    const cleanPmcid = normalizePmcid(query);
    if (cleanPmcid) {
      return this.fetchByPmcid(cleanPmcid, signal);
    }

    if (/^https?:\/\//i.test(query.trim())) {
      return this.fetchByUrl(query.trim(), signal);
    }

    return this.searchByTitle(query, signal);
  }

  async fetchByPmcid(
    pmcid: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    let url = `${this.BASE_URL}/pmcid:${encodeURIComponent(pmcid)}?mailto=${encodeURIComponent(this.mailto)}`;
    if (this.apiKey) {
      url += `&api_key=${encodeURIComponent(this.apiKey)}`;
    }

    const response = await this.executeFetch(url, signal);
    if (response.status === 404) return null;
    if (!response.ok) {
      const retryAfterMs = this.parseRetryAfterHeader(response);
      throw new ProviderFetchError(
        `OpenAlex API HTTP ${response.status} for PMCID: ${pmcid}`,
        response.status,
        retryAfterMs,
      );
    }

    const item = (await response.json()) as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') return null;
    return this.transformPayload(item, `pmcid:${pmcid}`, 0.95);
  }

  async fetchByUrl(
    targetUrl: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    let url = `${this.BASE_URL}?filter=locations.landing_page_url:${encodeURIComponent(targetUrl)}&mailto=${encodeURIComponent(this.mailto)}`;
    if (this.apiKey) {
      url += `&api_key=${encodeURIComponent(this.apiKey)}`;
    }

    const response = await this.executeFetch(url, signal);
    if (response.status === 404 || !response.ok) return null;

    const data = (await response.json()) as {
      results?: Array<Record<string, unknown>>;
    } | null;
    const item = Array.isArray(data?.results)
      ? data.results[0]
      : (data as Record<string, unknown> | null);
    if (
      !item ||
      (typeof item.title !== 'string' && typeof item.display_name !== 'string')
    ) {
      return null;
    }
    const itemDoi = typeof item.doi === 'string' ? item.doi : '';
    const identifier = normalizeDoi(itemDoi) || targetUrl;
    return this.transformPayload(item, identifier, 0.9);
  }

  private async fetchByPmid(
    pmid: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    let url = `${this.BASE_URL}/pmid:${encodeURIComponent(pmid)}?mailto=${encodeURIComponent(this.mailto)}`;
    if (this.apiKey) {
      url += `&api_key=${encodeURIComponent(this.apiKey)}`;
    }

    const response = await this.executeFetch(url, signal);

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterMs = this.parseRetryAfterHeader(response);
      throw new ProviderFetchError(
        `OpenAlex API HTTP ${response.status} for PMID: ${pmid}`,
        response.status,
        retryAfterMs,
      );
    }

    let item: unknown;
    try {
      item = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse OpenAlex JSON for PMID: ${pmid}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    if (!item || typeof item !== 'object') return null;
    return this.transformPayload(
      item as Record<string, unknown>,
      `pmid:${pmid}`,
      0.95,
    );
  }

  private async fetchByArxiv(
    cleanArxiv: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const rawId = cleanArxiv.replace(/^arxiv:\s*/i, '').trim();
    const idWithoutVersion = rawId.replace(/v\d+$/i, '');

    let url = `${this.BASE_URL}/https://doi.org/10.48550/arXiv.${encodeURIComponent(idWithoutVersion)}?mailto=${encodeURIComponent(this.mailto)}`;
    if (this.apiKey) {
      url += `&api_key=${encodeURIComponent(this.apiKey)}`;
    }

    const response = await this.executeFetch(url, signal);

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterMs = this.parseRetryAfterHeader(response);
      throw new ProviderFetchError(
        `OpenAlex arXiv lookup HTTP ${response.status} for ${cleanArxiv}`,
        response.status,
        retryAfterMs,
      );
    }

    let item: Record<string, unknown> | null = null;
    try {
      item = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderFetchError(
        `Failed to parse OpenAlex arXiv JSON for ${cleanArxiv}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    if (!item || typeof item !== 'object' || (typeof item.title !== 'string' && typeof item.display_name !== 'string')) {
      return null;
    }

    const itemDoi = typeof item.doi === 'string' ? item.doi : '';
    const doi = normalizeDoi(itemDoi) || `10.48550/arXiv.${idWithoutVersion}`;

    return this.transformPayload(item, doi, 0.95);
  }

  private async fetchByDoi(
    doi: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    let url = `${this.BASE_URL}/https://doi.org/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(this.mailto)}`;
    if (this.apiKey) {
      url += `&api_key=${encodeURIComponent(this.apiKey)}`;
    }

    const response = await this.executeFetch(url, signal);

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterMs = this.parseRetryAfterHeader(response);
      throw new ProviderFetchError(
        `OpenAlex API HTTP ${response.status} for DOI: ${doi}`,
        response.status,
        retryAfterMs,
      );
    }

    let item: unknown;
    try {
      item = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse OpenAlex JSON for DOI: ${doi}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    const payload = item as Record<string, unknown> | null;
    if (
      !payload ||
      (typeof payload.title !== 'string' &&
        typeof payload.display_name !== 'string')
    ) {
      return null;
    }
    return this.transformPayload(payload, doi, 0.9);
  }

  private async searchByTitle(
    title: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanTitle = title.trim();
    if (!cleanTitle) return null;

    let url = `${this.BASE_URL}?filter=title.search:${encodeURIComponent(cleanTitle)}&per-page=5&mailto=${encodeURIComponent(this.mailto)}`;
    if (this.apiKey) {
      url += `&api_key=${encodeURIComponent(this.apiKey)}`;
    }

    const response = await this.executeFetch(url, signal);

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterMs = this.parseRetryAfterHeader(response);
      throw new ProviderFetchError(
        `OpenAlex search HTTP ${response.status} for title: ${cleanTitle}`,
        response.status,
        retryAfterMs,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse OpenAlex search JSON for title: ${cleanTitle}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    const payload = json as { results?: Array<Record<string, unknown>> } | null;
    const results = payload?.results || [];

    const { bestMatch: item, bestScore } = this.rankBestTitleCandidate(
      results,
      cleanTitle,
      (candidate) =>
        typeof candidate.title === 'string'
          ? candidate.title
          : typeof candidate.display_name === 'string'
            ? candidate.display_name
            : undefined,
      TITLE_MATCH_THRESHOLD,
    );
    if (!item) {
      this.logger.debug(
        `OpenAlex title search rejected for "${cleanTitle}" (best similarity ${bestScore.toFixed(2)})`,
      );
      return null;
    }

    const itemDoi = typeof item.doi === 'string' ? item.doi : '';
    const identifier =
      normalizeDoi(itemDoi) || (typeof item.id === 'string' ? item.id : '');
    return this.transformPayload(item, identifier, 0.75);
  }

  private transformPayload(
    item: Record<string, unknown>,
    identifier: string,
    confidence: number,
  ): ProviderResult {
    const rawTitle =
      typeof item.title === 'string'
        ? item.title
        : typeof item.display_name === 'string'
          ? item.display_name
          : '';
    const title = cleanBibliographicText(rawTitle) || undefined;

    const authors: string[] = [];
    let firstAuthorInstitution: string | undefined;
    if (Array.isArray(item.authorships)) {
      for (const auth of item.authorships) {
        if (auth && typeof auth === 'object') {
          const authObj = auth as {
            author?: { display_name?: string };
            institutions?: Array<{ display_name?: string }>;
          };
          if (typeof authObj.author?.display_name === 'string') {
            authors.push(authObj.author.display_name.trim());
          }
          if (
            !firstAuthorInstitution &&
            Array.isArray(authObj.institutions) &&
            typeof authObj.institutions[0]?.display_name === 'string' &&
            authObj.institutions[0].display_name.trim()
          ) {
            firstAuthorInstitution =
              authObj.institutions[0].display_name.trim();
          }
        }
      }
    }

    const itemDoi = typeof item.doi === 'string' ? item.doi : '';
    const doi = normalizeDoi(itemDoi);
    const year =
      typeof item.publication_year === 'number' ? item.publication_year : null;

    const primLoc = item.primary_location as
      | {
          source?: {
            display_name?: string;
            host_organization_name?: string;
            issn_l?: string;
            issn?: string[];
            type?: string;
          };
          pdf_url?: string;
          landing_page_url?: string;
          license?: string;
        }
      | undefined;
    const hostVenue = item.host_venue as { display_name?: string } | undefined;

    const sourceName =
      primLoc?.source?.display_name || hostVenue?.display_name || undefined;
    const rawSourceType = primLoc?.source?.type;
    const sourceType =
      typeof rawSourceType === 'string' ? rawSourceType.toLowerCase() : '';

    const typeStr =
      typeof item.type === 'string' ? item.type.toLowerCase() : '';
    const typeCrossref =
      typeof item.type_crossref === 'string'
        ? item.type_crossref.toLowerCase()
        : '';
    const OPENALEX_TYPE_MAP: Record<string, string> = {
      article: 'journalArticle',
      review: 'journalArticle',
      letter: 'journalArticle',
      editorial: 'journalArticle',
      erratum: 'journalArticle',
      retraction: 'journalArticle',
      'journal-article': 'journalArticle',
      'proceedings-article': 'conferencePaper',
      'book-chapter': 'bookSection',
      book: 'book',
      monograph: 'book',
      dissertation: 'thesis',
      report: 'report',
      dataset: 'dataset',
      standard: 'standard',
      preprint: 'preprint',
      'posted-content': 'preprint',
      'reference-entry': 'encyclopediaArticle',
    };

    const isPreprint =
      typeStr === 'preprint' ||
      typeStr === 'posted-content' ||
      typeCrossref === 'posted-content' ||
      (sourceType === 'repository' &&
        (!typeStr || typeStr === 'article' || typeStr === 'other'));

    let itemType: string;
    if (isPreprint) {
      itemType = 'preprint';
    } else if (
      typeCrossref === 'proceedings-article' ||
      (typeStr === 'article' && sourceType === 'conference')
    ) {
      itemType = 'conferencePaper';
    } else if (typeStr) {
      itemType = OPENALEX_TYPE_MAP[typeStr] || 'document';
    } else {
      itemType = 'journalArticle';
    }
    const journal =
      isPreprint || itemType === 'bookSection' ? undefined : sourceName;
    const publicationTitle = isPreprint ? undefined : sourceName;
    const proceedingsTitle =
      itemType === 'conferencePaper' ? sourceName : undefined;
    const bookTitle = itemType === 'bookSection' ? sourceName : undefined;

    let abstract: string | undefined;
    if (
      item.abstract_inverted_index &&
      typeof item.abstract_inverted_index === 'object'
    ) {
      abstract = this.decodeInvertedIndex(
        item.abstract_inverted_index as Record<string, number[]>,
      );
    }

    const openAccess = item.open_access as
      { oa_url?: string; is_oa?: boolean } | undefined;
    const openAccessPdfUrl =
      openAccess?.oa_url || primLoc?.pdf_url || undefined;

    const canonicalUrl =
      (doi ? `https://doi.org/${doi}` : undefined) ||
      primLoc?.landing_page_url ||
      (typeof item.id === 'string' ? item.id : undefined);

    const biblio = (item.biblio || {}) as {
      volume?: string;
      issue?: string;
      first_page?: string;
      last_page?: string;
    };
    const pages = normalizePageRange(
      biblio.first_page
        ? biblio.last_page && biblio.last_page !== biblio.first_page
          ? `${biblio.first_page}-${biblio.last_page}`
          : biblio.first_page
        : undefined,
    );
    const publisher = primLoc?.source?.host_organization_name || undefined;
    const university =
      itemType === 'thesis'
        ? publisher || sourceName || firstAuthorInstitution
        : undefined;
    const institution =
      itemType === 'report'
        ? publisher || sourceName || firstAuthorInstitution
        : undefined;
    const issn =
      primLoc?.source?.issn_l || primLoc?.source?.issn?.[0] || undefined;

    const citationCount =
      typeof item.cited_by_count === 'number' && item.cited_by_count > 0
        ? item.cited_by_count
        : undefined;
    const referenceCount =
      typeof item.referenced_works_count === 'number' &&
      item.referenced_works_count > 0
        ? item.referenced_works_count
        : Array.isArray(item.referenced_works) &&
            item.referenced_works.length > 0
          ? item.referenced_works.length
          : undefined;

    const itemIdStr =
      typeof item.id === 'string' ? item.id : title || identifier;

    const rawKeywords: string[] = [];

    if (Array.isArray(item.keywords) && item.keywords.length > 0) {
      for (const rawK of item.keywords.slice(0, 8)) {
        const k = rawK as
          | string
          | { keyword?: string; display_name?: string; score?: number }
          | null
          | undefined;
        const text =
          typeof k === 'string' ? k : k?.keyword || k?.display_name || '';
        const score =
          typeof k === 'object' && typeof k?.score === 'number' ? k.score : 1.0;
        if (text && score >= 0.5) {
          rawKeywords.push(text);
        }
      }
    } else {
      const primaryTopic =
        item.primary_topic && typeof item.primary_topic === 'object'
          ? (item.primary_topic as { display_name?: unknown })
          : undefined;
      if (primaryTopic && typeof primaryTopic.display_name === 'string') {
        rawKeywords.push(primaryTopic.display_name);
      }
    }

    const keywords = normalizeAcademicTags(rawKeywords);

    const creators = authors.map((name, idx) =>
      parseCreatorString(name, idx, 'author'),
    );

    const language =
      typeof item.language === 'string' && item.language.trim()
        ? item.language.trim()
        : undefined;

    const license =
      typeof primLoc?.license === 'string' && primLoc.license.trim()
        ? primLoc.license.trim()
        : undefined;

    const ids = (item.ids || {}) as Record<string, string | string[]>;
    const rawArxivStr = typeof ids.arxiv === 'string' ? ids.arxiv : undefined;
    let rawArxiv = rawArxivStr
      ? normalizeArxivId(rawArxivStr) ||
        rawArxivStr.replace(/^https?:\/\/arxiv\.org\/abs\//i, '')
      : undefined;
    if (!rawArxiv) {
      const locations = Array.isArray(item.locations)
        ? (item.locations as Array<Record<string, unknown>>)
        : [];
      const candidateUrls = [
        primLoc?.landing_page_url,
        primLoc?.pdf_url,
        ...locations.flatMap((loc) => [loc.landing_page_url, loc.pdf_url]),
      ];
      for (const u of candidateUrls) {
        if (typeof u === 'string' && /arxiv\.org|10\.48550\/arxiv\./i.test(u)) {
          const parsedArxiv = normalizeArxivId(u);
          if (parsedArxiv) {
            rawArxiv = parsedArxiv;
            break;
          }
        }
      }
    }
    const rawPmidStr = typeof ids.pmid === 'string' ? ids.pmid : undefined;
    const rawPmid = rawPmidStr
      ? rawPmidStr
          .replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i, '')
          .replace(/\/+$/, '')
      : undefined;
    const rawPmcidStr = typeof ids.pmcid === 'string' ? ids.pmcid : undefined;
    const rawPmcid = rawPmcidStr ? normalizePmcid(rawPmcidStr) : undefined;
    const rawIsbnVal = Array.isArray(ids.isbn) ? ids.isbn[0] : ids.isbn;
    const rawIsbn =
      typeof rawIsbnVal === 'string' ? normalizeIsbn(rawIsbnVal) : undefined;

    const publicationDate =
      typeof item.publication_date === 'string'
        ? item.publication_date
        : undefined;

    const preprintRepo = isPreprint
      ? rawArxiv || /arxiv/i.test(sourceName || '')
        ? 'arXiv'
        : sourceName || undefined
      : undefined;

    return this.buildProviderResult({
      identifier: doi || identifier,
      rawPayload: item,
      confidenceScore: confidence,
      canonicalId: doi ? `doi:${doi}` : `openalex:${itemIdStr}`,
      sourceUrl: canonicalUrl,
      isOpenAccess: Boolean(openAccess?.is_oa),
      openAccessPdfUrl,
      metadata: {
        title,
        authors,
        creators,
        year,
        publicationDate,
        doi: doi || undefined,
        arxivId: rawArxiv,
        pmid: rawPmid,
        ...(rawPmcid ? { pmcid: rawPmcid } : {}),
        ...(rawIsbn ? { isbn: rawIsbn } : {}),
        journal,
        publicationTitle,
        ...(proceedingsTitle ? { proceedingsTitle } : {}),
        ...(bookTitle ? { bookTitle } : {}),
        ...(university ? { university } : {}),
        ...(institution ? { institution } : {}),
        volume: biblio.volume || undefined,
        issue: biblio.issue || undefined,
        pages,
        publisher: isPreprint
          ? undefined
          : publisher || university || institution,
        repository: preprintRepo,
        archiveId: rawArxiv
          ? `arXiv:${rawArxiv.replace(/^arxiv:\s*/i, '')}`
          : undefined,
        issn,
        abstract,
        citationCount,
        referenceCount,
        itemType,
        url: canonicalUrl,
        language,
        license,
        rights: license,
        keywords: keywords.length ? keywords : undefined,
        tags: keywords.length ? keywords : undefined,
        openAccessPdfUrl,
        libraryCatalog: 'OpenAlex',
      },
    });
  }

  private decodeInvertedIndex(index: Record<string, number[]>): string {
    const MAX_ABSTRACT_WORDS = 5000;
    const wordPositions: Array<{ word: string; pos: number }> = [];
    for (const [word, positions] of Object.entries(index)) {
      if (Array.isArray(positions)) {
        for (const pos of positions) {
          if (
            typeof pos === 'number' &&
            Number.isInteger(pos) &&
            pos >= 0 &&
            pos < MAX_ABSTRACT_WORDS &&
            wordPositions.length < MAX_ABSTRACT_WORDS
          ) {
            wordPositions.push({ word, pos });
          }
        }
      }
      if (wordPositions.length >= MAX_ABSTRACT_WORDS) break;
    }

    wordPositions.sort((a, b) => a.pos - b.pos);
    let joined = wordPositions
      .map((wp) => wp.word)
      .join(' ')
      .trim();

    joined = joined.replace(/\s+([.,;:!?%)\]}’'”])/g, '$1');
    joined = joined.replace(/([([{‘'“])\s+/g, '$1');

    return cleanAbstractText(joined) || joined;
  }
}
