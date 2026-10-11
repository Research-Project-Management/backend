import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  MetadataProvider,
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
  QueryType,
} from '../types/metadata.types';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizeTags,
  cleanAbstractText,
  cleanBibliographicText,
  titleSimilarity,
  TITLE_MATCH_THRESHOLD,
} from '../utils/metadata.utils';
import { ProviderFetchError } from '../services/metadata-executor.service';
import { normalizePageRange } from '../../shared-kernel/utils/bibliographic.utils';

@Injectable()
export class OpenAlexProvider implements MetadataProvider {
  readonly id: ProviderName = 'OpenAlex';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI', 'TITLE', 'ARXIV', 'PMID'],
    isAuthoritative: false,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  private readonly logger = new Logger(OpenAlexProvider.name);
  private readonly BASE_URL = 'https://api.openalex.org/works';

  private get mailto(): string {
    return (
      process.env.OPENALEX_EMAIL ||
      process.env.ACADEMIC_EMAIL ||
      'contact@flux.academic'
    );
  }

  private get apiKey(): string | undefined {
    return process.env.OPENALEX_API_KEY;
  }

  supports(queryType: QueryType): boolean {
    return this.capabilities.queryTypes.includes(queryType);
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const { query } = request;
    const cleanDoi = normalizeDoi(query);

    if (cleanDoi) {
      return this.fetchByDoi(cleanDoi, signal);
    }

    const cleanArxiv = normalizeArxivId(query, { stripVersion: true });
    if (cleanArxiv) {
      return this.fetchByArxiv(cleanArxiv, signal);
    }

    const cleanPmid = normalizePmid(query);
    if (cleanPmid) {
      return this.fetchByPmid(cleanPmid, signal);
    }

    return this.searchByTitle(query, signal);
  }

  private async fetchByPmid(
    pmid: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    let url = `${this.BASE_URL}/pmid:${encodeURIComponent(pmid)}?mailto=${encodeURIComponent(this.mailto)}`;
    if (this.apiKey) {
      url += `&api_key=${encodeURIComponent(this.apiKey)}`;
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': `FluxResearchPlatform/1.0 (mailto:${this.mailto}; https://flux.study)`,
        Accept: 'application/json',
      },
      signal,
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : undefined;
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

    let url = `${this.BASE_URL}?filter=locations.landing_page_url:http://arxiv.org/abs/${idWithoutVersion}|https://arxiv.org/abs/${idWithoutVersion}|https://doi.org/10.48550/arxiv.${idWithoutVersion}&per-page=5&mailto=${encodeURIComponent(this.mailto)}`;
    if (this.apiKey) {
      url += `&api_key=${encodeURIComponent(this.apiKey)}`;
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': `FluxResearchPlatform/1.0 (mailto:${this.mailto}; https://flux.study)`,
        Accept: 'application/json',
      },
      signal,
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : undefined;
      throw new ProviderFetchError(
        `OpenAlex arXiv lookup HTTP ${response.status} for ${cleanArxiv}`,
        response.status,
        retryAfterMs,
      );
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse OpenAlex arXiv JSON for ${cleanArxiv}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    const results = json?.results;
    if (!Array.isArray(results) || results.length === 0) {
      return null;
    }

    const sorted = [...results].sort(
      (a, b) => (b.cited_by_count || 0) - (a.cited_by_count || 0),
    );
    const item = sorted[0];
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

    const response = await fetch(url, {
      headers: {
        'User-Agent': `FluxResearchPlatform/1.0 (mailto:${this.mailto}; https://flux.study)`,
        Accept: 'application/json',
      },
      signal,
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : undefined;
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
    if (!payload || typeof payload.title !== 'string') return null;
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

    const response = await fetch(url, {
      headers: {
        'User-Agent': `FluxResearchPlatform/1.0 (mailto:${this.mailto}; https://flux.study)`,
        Accept: 'application/json',
      },
      signal,
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : undefined;
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

    let item: Record<string, unknown> | undefined;
    let bestScore = 0;
    for (const candidate of results) {
      if (typeof candidate.title !== 'string') continue;
      const score = titleSimilarity(cleanTitle, candidate.title);
      if (score > bestScore) {
        item = candidate;
        bestScore = score;
      }
    }
    if (!item || bestScore < TITLE_MATCH_THRESHOLD) {
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
    const title = cleanBibliographicText(rawTitle) || 'Untitled Paper';

    const authors: string[] = [];
    if (Array.isArray(item.authorships)) {
      for (const auth of item.authorships) {
        if (auth && typeof auth === 'object') {
          const authObj = auth as { author?: { display_name?: string } };
          if (typeof authObj.author?.display_name === 'string') {
            authors.push(authObj.author.display_name.trim());
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
    const journal = isPreprint ? undefined : sourceName;

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

    const rawVersion = createHash('md5')
      .update(JSON.stringify(item))
      .digest('hex');

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

    const itemIdStr = typeof item.id === 'string' ? item.id : title;

    const rawKeywords: string[] = [];

    if (Array.isArray(item.keywords) && item.keywords.length > 0) {
      for (const k of item.keywords.slice(0, 4)) {
        const text = typeof k === 'string' ? k : k?.keyword || k?.display_name;
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

    const keywords = normalizeTags(rawKeywords).slice(0, 4);

    const creators = authors.map((name, idx) => ({
      orderIndex: idx,
      creatorType: 'author',
      fullName: name,
    }));

    const language =
      typeof item.language === 'string' && item.language.trim()
        ? item.language.trim()
        : undefined;

    const license =
      typeof primLoc?.license === 'string' && primLoc.license.trim()
        ? primLoc.license.trim()
        : undefined;

    const ids = (item.ids || {}) as Record<string, string>;
    const rawArxiv = ids.arxiv
      ? ids.arxiv.replace(/^https?:\/\/arxiv\.org\/abs\//i, '')
      : undefined;
    const rawPmid = ids.pmid
      ? ids.pmid.replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i, '')
      : undefined;
    const publicationDate =
      typeof item.publication_date === 'string'
        ? item.publication_date
        : undefined;

    const preprintRepo = isPreprint
      ? rawArxiv || /arxiv/i.test(sourceName || '')
        ? 'arXiv'
        : sourceName || undefined
      : undefined;

    return {
      provider: this.id,
      metadata: {
        title,
        authors,
        creators,
        year,
        publicationDate,
        doi: doi || undefined,
        arxivId: rawArxiv,
        pmid: rawPmid,
        journal,
        publicationTitle: journal,
        volume: biblio.volume || undefined,
        issue: biblio.issue || undefined,
        pages,
        publisher: isPreprint ? undefined : publisher,
        repository: preprintRepo,
        archiveId: rawArxiv
          ? `arXiv:${rawArxiv.replace(/^arxiv:\s*/i, '').replace(/v\d+$/i, '')}`
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
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId: doi ? `doi:${doi}` : `openalex:${itemIdStr}`,
          canonicalUrl,
          confidenceScore: confidence,
          rawSnapshotHash: rawVersion,
          isOpenAccess: Boolean(openAccess?.is_oa),
          openAccessPdfUrl,
        },
      },
      confidence,
      identifier: doi || identifier,
      fetchedAt: new Date().toISOString(),
      rawVersion,
    };
  }

  private decodeInvertedIndex(index: Record<string, number[]>): string {
    const wordPositions: Array<{ word: string; pos: number }> = [];
    for (const [word, positions] of Object.entries(index)) {
      if (Array.isArray(positions)) {
        for (const pos of positions) {
          wordPositions.push({ word, pos });
        }
      }
    }

    wordPositions.sort((a, b) => a.pos - b.pos);
    let joined = wordPositions
      .map((wp) => wp.word)
      .join(' ')
      .trim();

    joined = joined.replace(/\s+([.,;:!?%)\]}’'”])/g, '$1');
    joined = joined.replace(/([([{‘'“])\s+/g, '$1');
    joined = joined.replace(/\s*([/-])\s*/g, '$1');

    return cleanAbstractText(joined) || joined;
  }
}
