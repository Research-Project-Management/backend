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
import { normalizeDoi } from '../utils/metadata.utils';
import { ProviderFetchError } from '../services/provider.executor';

@Injectable()
export class OpenAlexProvider implements MetadataProvider {
  readonly id: ProviderName = 'OpenAlex';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI', 'TITLE'],
    isAuthoritative: false,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  private readonly logger = new Logger(OpenAlexProvider.name);
  private readonly BASE_URL = 'https://api.openalex.org/works';

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
    return this.searchByTitle(query, signal);
  }

  private async fetchByDoi(
    doi: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const url = `${this.BASE_URL}/https://doi.org/${encodeURIComponent(doi)}?mailto=contact@flux.academic`;

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
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

    const url = `${this.BASE_URL}?filter=title.search:${encodeURIComponent(cleanTitle)}&per-page=1&mailto=contact@flux.academic`;

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
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
    const rawTitle = typeof item.title === 'string' ? item.title.trim() : 'Untitled Paper';
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
      | { source?: { display_name?: string; host_organization_name?: string; issn_l?: string; issn?: string[] }; pdf_url?: string; landing_page_url?: string }
      | undefined;
    const hostVenue = item.host_venue as { display_name?: string } | undefined;

    const journal =
      primLoc?.source?.display_name ||
      hostVenue?.display_name ||
      undefined;

    let itemType = 'journalArticle';
    const typeStr = typeof item.type === 'string' ? item.type : '';
    if (typeStr === 'book' || typeStr === 'monograph') itemType = 'book';
    else if (typeStr === 'book-chapter') itemType = 'bookSection';
    else if (typeStr === 'proceedings-article') itemType = 'conferencePaper';
    else if (typeStr === 'preprint') itemType = 'preprint';
    else if (typeStr === 'dataset') itemType = 'dataset';

    // Decode inverted index abstract
    let abstract: string | undefined;
    if (item.abstract_inverted_index && typeof item.abstract_inverted_index === 'object') {
      abstract = this.decodeInvertedIndex(item.abstract_inverted_index as Record<string, number[]>);
    }

    const openAccess = item.open_access as { oa_url?: string; is_oa?: boolean } | undefined;
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
    const publisher =
      primLoc?.source?.host_organization_name || undefined;
    const issn =
      primLoc?.source?.issn_l ||
      primLoc?.source?.issn?.[0] ||
      undefined;

    const citationCount =
      typeof item.cited_by_count === 'number' ? item.cited_by_count : undefined;

    const itemIdStr = typeof item.id === 'string' ? item.id : title;

    return {
      provider: this.id,
      metadata: {
        title,
        authors,
        year,
        doi: doi || undefined,
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
