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
} from '../utils/metadata.utils';
import { ProviderFetchError } from '../services/provider.executor';

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
      return this.fetchByDoi(`10.48550/arxiv.${cleanArxiv}`, signal);
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

    let url = `${this.BASE_URL}?filter=title.search:${encodeURIComponent(cleanTitle)}&per-page=1&mailto=${encodeURIComponent(this.mailto)}`;
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
    const item = payload?.results?.[0];
    if (!item || typeof item.title !== 'string') return null;

    const itemDoi = typeof item.doi === 'string' ? item.doi : '';
    const doi = normalizeDoi(itemDoi) || cleanTitle;
    return this.transformPayload(item, doi, 0.75);
  }

  private transformPayload(
    item: Record<string, unknown>,
    identifier: string,
    confidence: number,
  ): ProviderResult {
    const rawTitle =
      typeof item.title === 'string' ? item.title.trim() : 'Untitled Paper';
    const title = rawTitle || 'Untitled Paper';

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
          };
          pdf_url?: string;
          landing_page_url?: string;
        }
      | undefined;
    const hostVenue = item.host_venue as { display_name?: string } | undefined;

    const journal =
      primLoc?.source?.display_name || hostVenue?.display_name || undefined;

    let itemType = 'journalArticle';
    const typeStr = typeof item.type === 'string' ? item.type : '';
    if (typeStr === 'book' || typeStr === 'monograph') itemType = 'book';
    else if (typeStr === 'book-chapter') itemType = 'bookSection';
    else if (typeStr === 'proceedings-article') itemType = 'conferencePaper';
    else if (typeStr === 'preprint') itemType = 'preprint';
    else if (typeStr === 'dataset') itemType = 'dataset';

    // Decode inverted index abstract
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
    const pages = biblio.first_page
      ? biblio.last_page && biblio.last_page !== biblio.first_page
        ? `${biblio.first_page}-${biblio.last_page}`
        : biblio.first_page
      : undefined;
    const publisher = primLoc?.source?.host_organization_name || undefined;
    const issn =
      primLoc?.source?.issn_l || primLoc?.source?.issn?.[0] || undefined;

    const citationCount =
      typeof item.cited_by_count === 'number' ? item.cited_by_count : undefined;

    const itemIdStr = typeof item.id === 'string' ? item.id : title;

    const rawKeywords: string[] = [];

    // 1. Primary Topic & Curated Topics (OpenAlex v2 - Leiden CWTS taxonomy)
    const primaryTopic = (item as any).primary_topic;
    if (primaryTopic && typeof primaryTopic === 'object') {
      if (typeof primaryTopic.display_name === 'string') {
        rawKeywords.push(primaryTopic.display_name);
      }
      if (typeof primaryTopic.subfield?.display_name === 'string') {
        rawKeywords.push(primaryTopic.subfield.display_name);
      }
    }

    const topics = (item as any).topics;
    if (Array.isArray(topics)) {
      for (const t of topics.slice(0, 3)) {
        if (typeof t?.score === 'number' && t.score < 0.6) continue;
        if (typeof t?.display_name === 'string') rawKeywords.push(t.display_name);
        if (typeof t?.subfield?.display_name === 'string') rawKeywords.push(t.subfield.display_name);
      }
    }

    // 2. Author / Extracted Keywords
    if (Array.isArray(item.keywords)) {
      for (const k of item.keywords) {
        const text = typeof k === 'string' ? k : k?.keyword || k?.display_name;
        const score = typeof k === 'object' && typeof k?.score === 'number' ? k.score : 1.0;
        if (text && score >= 0.5) {
          rawKeywords.push(text);
        }
      }
    }

    // OpenAlex topics and author keywords are used; concepts are intentionally excluded to prevent Wikipedia pollution
    const keywords = normalizeTags(rawKeywords);


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
      typeof (primLoc as any)?.license === 'string' && (primLoc as any).license.trim()
        ? (primLoc as any).license.trim()
        : typeof (item.primary_location as any)?.license === 'string'
          ? (item.primary_location as any).license.trim()
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
        volume: biblio.volume || undefined,
        issue: biblio.issue || undefined,
        pages,
        publisher,
        issn,
        abstract,
        citationCount,
        itemType,
        url: canonicalUrl,
        language,
        license,
        rights: license,
        keywords: keywords.length ? keywords : undefined,
        tags: keywords.length ? keywords : undefined,
        openAccessPdfUrl,
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
    return wordPositions
      .map((wp) => wp.word)
      .join(' ')
      .trim();
  }
}
