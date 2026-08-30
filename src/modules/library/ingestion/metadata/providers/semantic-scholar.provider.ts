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
    maxConcurrency: 2,
  };

  private readonly logger = new Logger(SemanticScholarProvider.name);
  private readonly BASE_URL = 'https://api.semanticscholar.org/graph/v1/paper';
  private readonly FIELDS =
    'title,authors,year,venue,publicationVenue,journal,externalIds,abstract,citationCount,referenceCount,influentialCitationCount,openAccessPdf,tldr,publicationTypes,publicationDate,url';

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
        `Semantic Scholar API HTTP ${response.status} for: ${paperId}`,
        response.status,
        retryAfterMs,
      );
    }

    let item: any;
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

    if (!item || item.error || !item.title) return null;

    return this.transformPayload(item, rawQuery, 0.9);
  }

  private async searchByTitle(
    title: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanTitle = title.trim();
    if (!cleanTitle) return null;

    const url = `${this.BASE_URL}/search?query=${encodeURIComponent(cleanTitle)}&limit=1&fields=${this.FIELDS}`;

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
        `Semantic Scholar search HTTP ${response.status} for title: ${cleanTitle}`,
        response.status,
        retryAfterMs,
      );
    }

    let json: any;
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

    const item = json?.data?.[0];
    if (!item || !item.title) return null;

    return this.transformPayload(item, cleanTitle, 0.8);
  }

  private transformPayload(
    item: any,
    rawQuery: string,
    baseConfidence: number,
  ): ProviderResult {
    const title = item.title?.trim() || 'Untitled Paper';

    const authors: string[] = Array.isArray(item.authors)
      ? item.authors.map((a: any) => a.name).filter(Boolean)
      : [];

    const externalIds = item.externalIds || {};
    const doi = normalizeDoi(externalIds.DOI);
    const arxivId = normalizeArxivId(externalIds.ArXiv);
    const pmid = normalizePmid(externalIds.PubMed);

    const year = typeof item.year === 'number' ? item.year : null;
    const journal =
      item.journal?.name ||
      item.publicationVenue?.name ||
      item.venue ||
      undefined;

    let itemType = 'journalArticle';
    if (Array.isArray(item.publicationTypes)) {
      if (item.publicationTypes.includes('JournalArticle')) {
        itemType = 'journalArticle';
      } else if (item.publicationTypes.includes('Conference')) {
        itemType = 'conferencePaper';
      } else if (item.publicationTypes.includes('Book')) {
        itemType = 'book';
      } else if (item.publicationTypes.includes('Preprint') || arxivId) {
        itemType = 'preprint';
      }
    }

    const openAccessPdfUrl = item.openAccessPdf?.url || undefined;
    const rawVersion = createHash('md5')
      .update(JSON.stringify(item))
      .digest('hex');

    const canonicalUrl =
      item.url ||
      (doi
        ? `https://doi.org/${doi}`
        : `https://www.semanticscholar.org/paper/${item.paperId || ''}`);

    return {
      provider: this.id,
      metadata: {
        title,
        authors,
        year,
        doi,
        arxivId,
        pmid,
        journal,
        abstract: item.abstract?.trim() || undefined,
        tldr: item.tldr?.text?.trim() || undefined,
        citationCount: item.citationCount,
        referenceCount: item.referenceCount,
        influentialCitationCount: item.influentialCitationCount,
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
              : `s2:${item.paperId || title}`,
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
