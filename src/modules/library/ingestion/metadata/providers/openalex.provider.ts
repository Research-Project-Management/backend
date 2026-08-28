import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  MetadataProvider,
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
  QueryType,
} from '../metadata.contracts';
import { normalizeDoi } from '../metadata.identifiers';
import { ProviderFetchError } from '../metadata.executor';

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

    let item: any;
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

    if (!item || !item.title) return null;
    return this.transformPayload(item, doi, 0.9);
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

    let json: any;
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

    const item = json?.results?.[0];
    if (!item || !item.title) return null;

    const doi = normalizeDoi(item.doi) || cleanTitle;
    return this.transformPayload(item, doi, 0.75);
  }

  private transformPayload(
    item: any,
    identifier: string,
    confidence: number,
  ): ProviderResult {
    const title = item.title?.trim() || 'Untitled Paper';

    const authors: string[] = [];
    if (Array.isArray(item.authorships)) {
      for (const auth of item.authorships) {
        if (auth.author?.display_name) {
          authors.push(auth.author.display_name.trim());
        }
      }
    }

    const doi = normalizeDoi(item.doi);
    const year = typeof item.publication_year === 'number' ? item.publication_year : null;
    const journal =
      item.primary_location?.source?.display_name ||
      item.host_venue?.display_name ||
      undefined;

    let itemType = 'journalArticle';
    if (item.type === 'book' || item.type === 'monograph') itemType = 'book';
    else if (item.type === 'book-chapter') itemType = 'bookSection';
    else if (item.type === 'proceedings-article') itemType = 'conferencePaper';
    else if (item.type === 'preprint') itemType = 'preprint';
    else if (item.type === 'dataset') itemType = 'dataset';

    // Decode inverted index abstract
    let abstract: string | undefined;
    if (item.abstract_inverted_index) {
      abstract = this.decodeInvertedIndex(item.abstract_inverted_index);
    }

    const openAccessPdfUrl =
      item.open_access?.oa_url ||
      item.primary_location?.pdf_url ||
      undefined;

    const rawVersion = createHash('md5')
      .update(JSON.stringify(item))
      .digest('hex');

    const canonicalUrl =
      item.doi ||
      item.primary_location?.landing_page_url ||
      item.id;

    return {
      provider: this.id,
      metadata: {
        title,
        authors,
        year,
        doi,
        journal,
        abstract,
        citationCount: item.cited_by_count,
        itemType,
        url: canonicalUrl,
        openAccessPdfUrl,
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId: doi ? `doi:${doi}` : `openalex:${item.id || title}`,
          canonicalUrl,
          confidenceScore: confidence,
          rawSnapshotHash: rawVersion,
          isOpenAccess: Boolean(item.open_access?.is_oa),
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
    return wordPositions.map((wp) => wp.word).join(' ').trim();
  }
}
