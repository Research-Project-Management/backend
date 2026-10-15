/**
 * Canonical types and port interfaces for External Academic Search and Multi-Provider Benchmarking.
 *
 * Adheres to Clean Architecture:
 * - Domain contracts remain decoupled from specific search engine vendors.
 * - Allows side-by-side comparison between self-hosted (SearXNG) and open academic providers (EuropePMC).
 */

export const EXTERNAL_SEARCH_PROVIDERS = Symbol('EXTERNAL_SEARCH_PROVIDERS');
export const EXTERNAL_SEARCH_PORT = Symbol('EXTERNAL_SEARCH_PORT');

export interface ExternalSearchPaperHit {
  title: string;
  url: string;
  snippet?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  arxivId?: string;
  pmid?: string;
  pdfUrl?: string;
  sourceEngine?: string;
  confidenceScore: number;
  rawMetadata?: Record<string, unknown>;
}

export interface ExternalSearchOptions {
  limit?: number;
  category?: 'science' | 'general';
  timeoutMs?: number;
}

export interface ExternalSearchResult {
  provider: string;
  query: string;
  hits: ExternalSearchPaperHit[];
  latencyMs: number;
  isAvailable: boolean;
  statusCode?: number;
  error?: string;
}

export interface IExternalSearchProvider {
  readonly providerName: string;
  isAvailable(): Promise<boolean>;
  search(
    query: string,
    options?: ExternalSearchOptions,
  ): Promise<ExternalSearchResult>;
}

export interface ProviderComparisonMetrics {
  latencyMs: number;
  hitsCount: number;
  doiResolutionRate: number; // Tỉ lệ bóc được DOI hợp lệ (0.0 -> 1.0)
  pdfDetectionRate: number; // Tỉ lệ phát hiện được link PDF trực tiếp (0.0 -> 1.0)
  averageConfidence: number; // Điểm tin cậy trung bình của các hits
}

export interface SearchComparisonReport {
  query: string;
  executedAt: string;
  providers: Record<string, ExternalSearchResult>;
  metrics: Record<string, ProviderComparisonMetrics>;
  summary: {
    fastestProvider: string;
    highestYieldProvider: string;
    recommendedSource: string;
  };
}
