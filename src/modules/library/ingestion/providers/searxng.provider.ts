import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IExternalSearchProvider,
  ExternalSearchOptions,
  ExternalSearchResult,
  ExternalSearchPaperHit,
} from '@/modules/library/ingestion/types/external-search.types';
import {
  deriveDoiFromPublisherUrl,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
} from '@/modules/library/core';

const DEFAULT_SEARXNG_TIMEOUT_MS = 5000;
const DEFAULT_LIMIT = 10;

interface SearxngRawResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  parsed_url?: string[];
  publishedDate?: string;
  doi?: string;
  arxiv_id?: string;
  pmid?: string;
}

interface SearxngResponse {
  query?: string;
  number_of_results?: number;
  results?: SearxngRawResult[];
  unresponsive_engines?: [string, string][];
}

@Injectable()
export class SearxngSearchProvider implements IExternalSearchProvider {
  readonly providerName = 'searxng';
  private readonly logger = new Logger(SearxngSearchProvider.name);

  constructor(@Optional() private readonly configService?: ConfigService) {}

  private get baseUrl(): string {
    const configured = this.configService?.get<string>('SEARXNG_BASE_URL');
    return (
      configured ||
      process.env.SEARXNG_BASE_URL ||
      'http://localhost:8080'
    ).replace(/\/+$/, '');
  }

  async isAvailable(): Promise<boolean> {
    try {
      const signal = AbortSignal.timeout(1500);
      const res = await fetch(`${this.baseUrl}/healthz`, {
        method: 'GET',
        signal,
      });
      return res.ok || res.status === 200 || res.status === 404; // some SearXNG versions return 200 on / or 404 on healthz but server is up
    } catch {
      return false;
    }
  }

  async search(
    query: string,
    options?: ExternalSearchOptions,
  ): Promise<ExternalSearchResult> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs || DEFAULT_SEARXNG_TIMEOUT_MS;
    const limit = options?.limit || DEFAULT_LIMIT;
    const category = options?.category || 'science';

    try {
      const url = new URL(`${this.baseUrl}/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('categories', category);

      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Flux-Academic-Crawler/1.0',
        },
        signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        return {
          provider: this.providerName,
          query,
          hits: [],
          latencyMs,
          isAvailable: true,
          statusCode: res.status,
          error: `SearXNG returned HTTP ${res.status}: ${res.statusText}`,
        };
      }

      const data = (await res.json()) as SearxngResponse;
      const rawResults = Array.isArray(data.results) ? data.results : [];

      const hits: ExternalSearchPaperHit[] = rawResults
        .slice(0, limit)
        .map((item) => this.mapToHit(item));

      return {
        provider: this.providerName,
        query,
        hits,
        latencyMs,
        isAvailable: true,
        statusCode: 200,
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - startTime;
      const isAbort =
        err &&
        typeof err === 'object' &&
        ((err as { name?: string }).name === 'TimeoutError' ||
          (err as { name?: string }).name === 'AbortError');
      const errorMessage = isAbort
        ? `SearXNG timeout after ${timeoutMs}ms`
        : `SearXNG connection error: ${err instanceof Error ? err.message : 'Unknown'}`;

      this.logger.debug(errorMessage);

      return {
        provider: this.providerName,
        query,
        hits: [],
        latencyMs,
        isAvailable: false,
        error: errorMessage,
      };
    }
  }

  private mapToHit(item: SearxngRawResult): ExternalSearchPaperHit {
    const rawUrl = item.url || '';
    const title = (item.title || '').replace(/<[^>]+>/g, '').trim();
    const snippet = (item.content || '').replace(/<[^>]+>/g, '').trim();

    // 1. Identifier extraction
    const doiCandidate = item.doi || deriveDoiFromPublisherUrl(rawUrl);
    const doi = doiCandidate ? normalizeDoi(doiCandidate) : undefined;

    let arxivId: string | undefined = item.arxiv_id;
    if (!arxivId && rawUrl) {
      const match = rawUrl.match(
        /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:)([\d.]+v?\d*)/i,
      );
      if (match) arxivId = normalizeArxivId(match[1]);
    }

    let pmid: string | undefined = item.pmid;
    if (!pmid && rawUrl) {
      const match = rawUrl.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
      if (match) pmid = normalizePmid(match[1]);
    }

    // 2. Direct PDF detection
    let pdfUrl: string | undefined;
    if (rawUrl.toLowerCase().endsWith('.pdf')) {
      pdfUrl = rawUrl;
    } else if (arxivId) {
      pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
    }

    // 3. Year extraction from publishedDate (e.g. "2023-05-12" or "2023")
    let year: number | undefined;
    if (item.publishedDate) {
      const yearMatch = item.publishedDate.match(/\b(19\d\d|20\d\d)\b/);
      if (yearMatch) {
        year = parseInt(yearMatch[1], 10);
      }
    }

    // 4. Verification Scoring Matrix
    let confidenceScore = 0.0;
    if (doi || arxivId || pmid) confidenceScore += 0.4;
    if (title.length > 5) confidenceScore += 0.3;
    const engine = (item.engine || '').toLowerCase();
    if (
      [
        'arxiv',
        'pubmed',
        'google scholar',
        'crossref',
        'semantic scholar',
      ].includes(engine)
    ) {
      confidenceScore += 0.2;
    } else {
      confidenceScore += 0.1;
    }
    if (pdfUrl) confidenceScore += 0.1;

    return {
      title,
      url: rawUrl,
      snippet: snippet || undefined,
      year,
      doi,
      arxivId,
      pmid,
      pdfUrl,
      sourceEngine: item.engine || 'searxng',
      confidenceScore: Math.min(1.0, Math.round(confidenceScore * 100) / 100),
      rawMetadata: {
        publishedDate: item.publishedDate,
        engine: item.engine,
      },
    };
  }
}
