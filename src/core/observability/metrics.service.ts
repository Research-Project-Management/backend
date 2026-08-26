import { Injectable, Logger } from '@nestjs/common';
import { CoreMetricSummary, StageMetricRecord } from './observability.types';

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  private readonly ingestionStages: StageMetricRecord[] = [];
  private totalCitations = 0;
  private citationCacheHits = 0;
  private totalCitationDurationMs = 0;

  private totalSearches = 0;
  private totalSearchDurationMs = 0;

  private cacheStats = {
    metadata: { hits: 0, misses: 0 },
    citation: { hits: 0, misses: 0 },
  };

  /**
   * Record pipeline stage telemetry
   */
  recordIngestionStage(
    stage: string,
    durationMs: number,
    success: boolean = true,
  ): void {
    this.ingestionStages.push({
      stage,
      durationMs,
      success,
      timestamp: new Date().toISOString(),
    });

    if (this.ingestionStages.length > 5000) {
      this.ingestionStages.shift();
    }
  }

  /**
   * Record citation rendering latency and cache hit
   */
  recordCitationRender(
    _style: string,
    cached: boolean,
    durationMs: number,
  ): void {
    this.totalCitations++;
    if (cached) this.citationCacheHits++;
    this.totalCitationDurationMs += durationMs;
  }

  /**
   * Record search latency
   */
  recordSearchQuery(durationMs: number): void {
    this.totalSearches++;
    this.totalSearchDurationMs += durationMs;
  }

  /**
   * Record general cache hit or miss
   */
  recordCacheAccess(cacheType: 'metadata' | 'citation', hit: boolean): void {
    if (hit) {
      this.cacheStats[cacheType].hits++;
    } else {
      this.cacheStats[cacheType].misses++;
    }
  }

  /**
   * Summarize current metrics
   */
  getMetricsSummary(): CoreMetricSummary {
    const totalRuns = this.ingestionStages.length;
    const failures = this.ingestionStages.filter((s) => !s.success).length;
    const totalDuration = this.ingestionStages.reduce(
      (acc, s) => acc + s.durationMs,
      0,
    );

    const stageBreakdown: Record<
      string,
      { count: number; avgDurationMs: number; failures: number }
    > = {};
    for (const record of this.ingestionStages) {
      if (!stageBreakdown[record.stage]) {
        stageBreakdown[record.stage] = {
          count: 0,
          avgDurationMs: 0,
          failures: 0,
        };
      }
      const entry = stageBreakdown[record.stage];
      entry.count++;
      if (!record.success) entry.failures++;
    }

    for (const stage of Object.keys(stageBreakdown)) {
      const records = this.ingestionStages.filter((r) => r.stage === stage);
      const stageTotalDur = records.reduce((acc, r) => acc + r.durationMs, 0);
      stageBreakdown[stage].avgDurationMs = records.length
        ? Math.round(stageTotalDur / records.length)
        : 0;
    }

    const metaHits = this.cacheStats.metadata.hits;
    const metaTotal = metaHits + this.cacheStats.metadata.misses;
    const citHits = this.cacheStats.citation.hits;
    const citTotal = citHits + this.cacheStats.citation.misses;

    return {
      ingestion: {
        totalRuns,
        failures,
        avgDurationMs: totalRuns ? Math.round(totalDuration / totalRuns) : 0,
        stageBreakdown,
      },
      citations: {
        totalRenders: this.totalCitations,
        cacheHitRatio: this.totalCitations
          ? +(this.citationCacheHits / this.totalCitations).toFixed(4)
          : 0,
        avgRenderMs: this.totalCitations
          ? Math.round(this.totalCitationDurationMs / this.totalCitations)
          : 0,
      },
      searches: {
        totalSearches: this.totalSearches,
        avgSearchMs: this.totalSearches
          ? Math.round(this.totalSearchDurationMs / this.totalSearches)
          : 0,
      },
      cache: {
        metadata: {
          hits: metaHits,
          misses: this.cacheStats.metadata.misses,
          hitRatio: metaTotal ? +(metaHits / metaTotal).toFixed(4) : 0,
        },
        citation: {
          hits: citHits,
          misses: this.cacheStats.citation.misses,
          hitRatio: citTotal ? +(citHits / citTotal).toFixed(4) : 0,
        },
      },
    };
  }
}
