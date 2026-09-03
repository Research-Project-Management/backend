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
  normalizeArxivId,
  normalizeDoi,
  normalizePmid,
} from '../utils/metadata.utils';
import { ProviderFetchError } from '../services/provider.executor';

@Injectable()
export class SemanticScholarProvider implements MetadataProvider {
  readonly id: ProviderName = 'SemanticScholar';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI', 'ARXIV', 'PMID', 'TITLE', 'URL'],
    isAuthoritative: false,
    timeoutMs: 8000,
    maxConcurrency: 1,
  };

  private readonly logger = new Logger(SemanticScholarProvider.name);
  private readonly BASE_URL = 'https://api.semanticscholar.org/graph/v1/paper';
  private readonly FIELDS =
    'title,authors,year,venue,publicationVenue,journal,externalIds,abstract,citationCount,referenceCount,influentialCitationCount,openAccessPdf,tldr,publicationTypes,publicationDate,url';

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent':
        'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
      Accept: 'application/json',
    };
    const apiKey =
      process.env.SEMANTIC_SCHOLAR_API_KEY || process.env.S2_API_KEY;
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }
    return headers;
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
      return this.fetchById(`DOI:${cleanDoi}`, cleanDoi, signal);
    }

    const cleanArxiv = normalizeArxivId(query);
    if (cleanArxiv) {
      return this.fetchById(`ARXIV:${cleanArxiv}`, cleanArxiv, signal);
    }

    const cleanPmid = normalizePmid(query);
    if (cleanPmid) {
      return this.fetchById(`PMID:${cleanPmid}`, cleanPmid, signal);
    }

    if (/^https?:\/\//i.test(query.trim())) {
      return this.fetchById(`URL:${query.trim()}`, query.trim(), signal);
    }

    return this.searchByTitle(query, signal);
  }

  private async fetchById(
    paperId: string,
    rawQuery: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const url = `${this.BASE_URL}/${encodeURIComponent(paperId)}?fields=${this.FIELDS}`;

    const response = await fetch(url, {
      headers: this.getHeaders(),
      signal,
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : undefined;
      throw new ProviderFetchError(
        `Semantic Scholar API HTTP ${response.status} for: ${paperId}`,
        response.status,
        retryAfterMs,
      );
    }

    let item: unknown;
    try {
      item = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse Semantic Scholar JSON for: ${paperId}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    const payload = item as Record<string, unknown> | null;
    if (!payload || payload.error || typeof payload.title !== 'string')
      return null;

    return this.transformPayload(payload, rawQuery, 0.9);
  }

  private async searchByTitle(
    title: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanTitle = title.trim();
    if (!cleanTitle) return null;

    // 1. Try specialized paper match endpoint first (optimized for title matching)
    try {
      const matchUrl = `${this.BASE_URL}/search/match?query=${encodeURIComponent(cleanTitle)}&fields=${this.FIELDS}`;
      const matchRes = await fetch(matchUrl, {
        headers: this.getHeaders(),
        signal,
      });

      if (matchRes.ok) {
        const matchJson = (await matchRes.json()) as {
          data?: Array<Record<string, unknown>>;
        } | null;
        const matchedItem = matchJson?.data?.[0];
        if (matchedItem && typeof matchedItem.title === 'string') {
          return this.transformPayload(matchedItem, cleanTitle, 0.88);
        }
      }
    } catch {
      // Fallback to standard search if match fails
    }

    // 2. Fallback to standard search endpoint
    const url = `${this.BASE_URL}/search?query=${encodeURIComponent(cleanTitle)}&limit=1&fields=${this.FIELDS}`;

    const response = await fetch(url, {
      headers: this.getHeaders(),
      signal,
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : undefined;
      throw new ProviderFetchError(
        `Semantic Scholar search HTTP ${response.status} for title: ${cleanTitle}`,
        response.status,
        retryAfterMs,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse Semantic Scholar search JSON for title: ${cleanTitle}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    const payload = json as { data?: Array<Record<string, unknown>> } | null;
    const item = payload?.data?.[0];
    if (!item || typeof item.title !== 'string') return null;

    return this.transformPayload(item, cleanTitle, 0.8);
  }

  private transformPayload(
    item: Record<string, unknown>,
    rawQuery: string,
    baseConfidence: number,
  ): ProviderResult {
    const rawTitle =
      typeof item.title === 'string' ? item.title.trim() : 'Untitled Paper';
    const title = rawTitle || 'Untitled Paper';

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

    const externalIds = (item.externalIds || {}) as Record<
      string,
      string | undefined
    >;
    const doi = normalizeDoi(
      typeof externalIds.DOI === 'string' ? externalIds.DOI : undefined,
    );
    const arxivId = normalizeArxivId(
      typeof externalIds.ArXiv === 'string' ? externalIds.ArXiv : undefined,
    );
    const pmid = normalizePmid(
      typeof externalIds.PubMed === 'string' ? externalIds.PubMed : undefined,
    );

    const year = typeof item.year === 'number' ? item.year : null;
    const journalObj = item.journal as { name?: string } | undefined;
    const pubVenueObj = item.publicationVenue as { name?: string } | undefined;
    const venueStr = typeof item.venue === 'string' ? item.venue : undefined;

    const journal =
      journalObj?.name || pubVenueObj?.name || venueStr || undefined;

    let itemType = 'journalArticle';
    if (Array.isArray(item.publicationTypes)) {
      const pubTypes = item.publicationTypes as string[];
      if (pubTypes.includes('JournalArticle')) {
        itemType = 'journalArticle';
      } else if (pubTypes.includes('Conference')) {
        itemType = 'conferencePaper';
      } else if (pubTypes.includes('Book')) {
        itemType = 'book';
      } else if (pubTypes.includes('Preprint') || arxivId) {
        itemType = 'preprint';
      }
    }

    const openAccessPdf = item.openAccessPdf as { url?: string } | undefined;
    const openAccessPdfUrl = openAccessPdf?.url || undefined;
    const rawVersion = createHash('md5')
      .update(JSON.stringify(item))
      .digest('hex');

    const paperIdStr = typeof item.paperId === 'string' ? item.paperId : '';
    const itemUrl = typeof item.url === 'string' ? item.url : undefined;
    const canonicalUrl =
      itemUrl ||
      (doi
        ? `https://doi.org/${doi}`
        : `https://www.semanticscholar.org/paper/${paperIdStr}`);

    const abstractStr =
      typeof item.abstract === 'string' ? item.abstract.trim() : undefined;
    const tldrObj = item.tldr as { text?: string } | undefined;
    const tldrStr =
      typeof tldrObj?.text === 'string' ? tldrObj.text.trim() : undefined;

    const citationCount =
      typeof item.citationCount === 'number' ? item.citationCount : undefined;
    const referenceCount =
      typeof item.referenceCount === 'number' ? item.referenceCount : undefined;
    const influentialCitationCount =
      typeof item.influentialCitationCount === 'number'
        ? item.influentialCitationCount
        : undefined;

    const creators = authors.map((name, idx) => ({
      orderIndex: idx,
      creatorType: 'author',
      fullName: name,
    }));

    const keywords: string[] = [];
    if (Array.isArray(item.fieldsOfStudy)) {
      for (const fos of item.fieldsOfStudy) {
        if (typeof fos === 'string' && fos.trim()) {
          keywords.push(fos.trim());
        }
      }
    }

    const notes = tldrStr
      ? [{ content: `TL;DR: ${tldrStr}`, source: 'SemanticScholar' }]
      : undefined;

    return {
      provider: this.id,
      metadata: {
        title,
        authors,
        creators,
        year,
        doi,
        arxivId,
        pmid,
        journal,
        abstract: abstractStr || undefined,
        tldr: tldrStr || undefined,
        notes,
        keywords: keywords.length ? keywords : undefined,
        tags: keywords.length ? keywords : undefined,
        citationCount,
        referenceCount,
        influentialCitationCount,
        itemType,
        url: canonicalUrl,
        openAccessPdfUrl,
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId: doi
            ? `doi:${doi}`
            : arxivId
              ? `arxiv:${arxivId}`
              : `s2:${paperIdStr || title}`,
          canonicalUrl,
          confidenceScore: baseConfidence,
          rawSnapshotHash: rawVersion,
          isOpenAccess: Boolean(openAccessPdfUrl),
          openAccessPdfUrl,
        },
      },
      confidence: baseConfidence,
      identifier: doi || arxivId || pmid || rawQuery,
      fetchedAt: new Date().toISOString(),
      rawVersion,
    };
  }
}
