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
export class CrossRefProvider implements MetadataProvider {
  readonly id: ProviderName = 'CrossRef';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI', 'TITLE'],
    isAuthoritative: true,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  private readonly logger = new Logger(CrossRefProvider.name);

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
      return this.resolveByDoi(cleanDoi, signal);
    }
    return this.searchByTitle(query, signal);
  }

  private async resolveByDoi(
    doi: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
        Accept: 'application/json',
      },
      signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : undefined;
      throw new ProviderFetchError(
        `CrossRef API HTTP ${response.status} for DOI: ${doi}`,
        response.status,
        retryAfterMs,
      );
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse CrossRef JSON for DOI: ${doi}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    if (!json?.message) return null;
    return this.transformMessage(json.message, doi, true);
  }

  private async searchByTitle(
    title: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanTitle = title.trim();
    if (!cleanTitle) return null;

    const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(cleanTitle)}&rows=1&mailto=contact@flux.academic`;

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
        `CrossRef search HTTP ${response.status} for title: ${cleanTitle}`,
        response.status,
        retryAfterMs,
      );
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse CrossRef search JSON for title: ${cleanTitle}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    const item = json?.message?.items?.[0];
    if (!item) return null;

    const doi = normalizeDoi(item.DOI) || item.DOI || '';
    return this.transformMessage(item, doi, false);
  }

  private transformMessage(
    message: Record<string, any>,
    doi: string,
    isDirectDoi: boolean,
  ): ProviderResult {
    const title = Array.isArray(message.title)
      ? message.title[0] || 'Untitled'
      : message.title || 'Untitled';

    const authors: string[] = [];
    if (Array.isArray(message.author)) {
      for (const auth of message.author) {
        if (auth.given && auth.family) {
          authors.push(`${auth.family}, ${auth.given}`);
        } else if (auth.family) {
          authors.push(auth.family);
        } else if (auth.name) {
          authors.push(auth.name);
        }
      }
    }

    let year: number | null = null;
    const dateParts =
      message['published-print']?.['date-parts']?.[0] ||
      message['published-online']?.['date-parts']?.[0] ||
      message.issued?.['date-parts']?.[0];
    if (dateParts && dateParts[0]) {
      year = Number(dateParts[0]);
    }

    const journal = Array.isArray(message['container-title'])
      ? message['container-title'][0]
      : message['container-title'] || undefined;

    const itemType =
      message.type === 'journal-article'
        ? 'journalArticle'
        : message.type === 'proceedings-article'
          ? 'conferencePaper'
          : message.type === 'book'
            ? 'book'
            : message.type || 'journalArticle';

    const keywords: string[] = [];
    if (Array.isArray(message.subject)) {
      keywords.push(...message.subject.filter(Boolean));
    }

    const journalAbbr = Array.isArray(message['short-container-title'])
      ? message['short-container-title'][0]
      : message['short-container-title'] || undefined;

    const series = Array.isArray(message['collection-title'])
      ? message['collection-title'][0]
      : message['collection-title'] || undefined;

    const rawVersion = createHash('md5')
      .update(JSON.stringify(message))
      .digest('hex');

    return {
      provider: this.id,
      metadata: {
        doi: doi || undefined,
        title,
        authors,
        year,
        journal,
        journalAbbr,
        publisher: message.publisher,
        volume: message.volume,
        issue: message.issue,
        pages: message.page,
        series,
        issn: Array.isArray(message.ISSN) ? message.ISSN[0] : message.ISSN,
        isbn: Array.isArray(message.ISBN) ? message.ISBN[0] : message.ISBN,
        url: message.URL || (doi ? `https://doi.org/${doi}` : undefined),
        abstract: message.abstract
          ? message.abstract.replace(/<[^>]*>/g, '').trim()
          : undefined,
        keywords: keywords.length ? keywords : undefined,
        itemType,
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId: doi ? `doi:${doi}` : `crossref:${title}`,
          canonicalUrl:
            message.URL || (doi ? `https://doi.org/${doi}` : undefined),
          confidenceScore: isDirectDoi ? 0.99 : 0.85,
          rawSnapshotHash: rawVersion,
          isOpenAccess: Boolean(
            message.link?.some(
              (l: any) => l['content-type'] === 'application/pdf',
            ),
          ),
        },
      },
      confidence: isDirectDoi ? 0.99 : 0.85,
      identifier: doi || title,
      fetchedAt: new Date().toISOString(),
      rawVersion,
    };
  }
}
