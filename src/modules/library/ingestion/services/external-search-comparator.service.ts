import { Injectable, Logger } from '@nestjs/common';
import {
  IExternalSearchProvider,
  ExternalSearchOptions,
  ExternalSearchResult,
  ProviderComparisonMetrics,
  SearchComparisonReport,
} from '@/modules/library/ingestion/types/external-search.types';
import { SearxngSearchProvider } from '@/modules/library/ingestion/providers/searxng.provider';
import { EuropePmcSearchProvider } from '@/modules/library/ingestion/providers/europe-pmc-search.provider';

@Injectable()
export class ExternalSearchComparatorService {
  private readonly logger = new Logger(ExternalSearchComparatorService.name);
  private readonly providers: IExternalSearchProvider[];

  constructor(
    private readonly searxngProvider: SearxngSearchProvider,
    private readonly europePmcProvider: EuropePmcSearchProvider,
  ) {
    this.providers = [this.searxngProvider, this.europePmcProvider];
  }

  /**
   * Runs the exact same query across all providers simultaneously and computes a side-by-side comparison report.
   */
  async compare(
    query: string,
    options?: ExternalSearchOptions,
  ): Promise<SearchComparisonReport> {
    const resultsMap: Record<string, ExternalSearchResult> = {};
    const metricsMap: Record<string, ProviderComparisonMetrics> = {};

    const settled = await Promise.allSettled(
      this.providers.map((p) => p.search(query, options)),
    );

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const outcome = settled[i];

      if (outcome.status === 'fulfilled') {
        const res = outcome.value;
        resultsMap[provider.providerName] = res;
        metricsMap[provider.providerName] = this.computeMetrics(res);
      } else {
        const errorResult: ExternalSearchResult = {
          provider: provider.providerName,
          query,
          hits: [],
          latencyMs: 0,
          isAvailable: false,
          error: outcome.reason?.message || 'Execution failed',
        };
        resultsMap[provider.providerName] = errorResult;
        metricsMap[provider.providerName] = this.computeMetrics(errorResult);
      }
    }

    // Determine fastest & highest yield providers among available ones
    let fastestProvider = 'none';
    let minLatency = Infinity;
    let highestYieldProvider = 'none';
    let maxHits = -1;

    for (const [name, metric] of Object.entries(metricsMap)) {
      if (metric.hitsCount > 0 && metric.latencyMs < minLatency) {
        minLatency = metric.latencyMs;
        fastestProvider = name;
      }
      if (metric.hitsCount > maxHits) {
        maxHits = metric.hitsCount;
        highestYieldProvider = name;
      }
    }

    // Determine recommendation
    let recommendedSource = 'searxng';
    if (resultsMap.searxng?.hits?.length === 0) {
      recommendedSource = resultsMap.europepmc?.hits?.length
        ? 'europepmc'
        : 'searxng';
    }

    return {
      query,
      executedAt: new Date().toISOString(),
      providers: resultsMap,
      metrics: metricsMap,
      summary: {
        fastestProvider,
        highestYieldProvider,
        recommendedSource,
      },
    };
  }

  /**
   * Resilient search router: Attempts self-hosted SearXNG first (0đ), then EuropePMC.
   */
  async search(
    query: string,
    options?: ExternalSearchOptions,
  ): Promise<ExternalSearchResult> {
    // 1. Try SearXNG (0đ, self-hosted, privacy-first)
    const searxngRes = await this.searxngProvider.search(query, options);
    if (searxngRes.isAvailable && searxngRes.hits.length > 0) {
      return searxngRes;
    }

    // 2. Fallback to EuropePMC (0đ, open academic mirror)
    this.logger.debug(
      `SearXNG yielded 0 hits or unavailable. Falling back to EuropePMC for "${query}"...`,
    );
    const europeRes = await this.europePmcProvider.search(query, options);
    if (europeRes.isAvailable && europeRes.hits.length > 0) {
      return europeRes;
    }

    // Return the initial SearXNG response or the last attempted
    return searxngRes;
  }

  private computeMetrics(res: ExternalSearchResult): ProviderComparisonMetrics {
    const totalHits = res.hits.length;
    if (totalHits === 0) {
      return {
        latencyMs: res.latencyMs,
        hitsCount: 0,
        doiResolutionRate: 0,
        pdfDetectionRate: 0,
        averageConfidence: 0,
      };
    }

    const doiCount = res.hits.filter((h) => Boolean(h.doi)).length;
    const pdfCount = res.hits.filter((h) => Boolean(h.pdfUrl)).length;
    const totalScore = res.hits.reduce(
      (acc, h) => acc + (h.confidenceScore || 0),
      0,
    );

    return {
      latencyMs: res.latencyMs,
      hitsCount: totalHits,
      doiResolutionRate: Math.round((doiCount / totalHits) * 100) / 100,
      pdfDetectionRate: Math.round((pdfCount / totalHits) * 100) / 100,
      averageConfidence: Math.round((totalScore / totalHits) * 100) / 100,
    };
  }
}
