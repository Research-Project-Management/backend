/**
 * modules/manuscripts/clsi/core/adapters/telemetry/clsi.metrics.ts
 * Telemetry and metrics aggregator for CLSI compilation performance.
 * Emits standard Prometheus format matching Overleaf Metrics.js.
 */

export interface CompileMetricSample {
  engine: string;
  durationMs: number;
  success: boolean;
  isCached: boolean;
  isTimeout: boolean;
  pdfSizeBytes?: number;
}

export class ClsiMetrics {
  private static instance: ClsiMetrics;

  private totalCompiles = 0;
  private successfulCompiles = 0;
  private failedCompiles = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private timeouts = 0;
  private totalPdfBytes = 0;

  private durationsByEngine = new Map<
    string,
    { count: number; totalMs: number; minMs: number; maxMs: number }
  >();

  public static getInstance(): ClsiMetrics {
    if (!ClsiMetrics.instance) {
      ClsiMetrics.instance = new ClsiMetrics();
    }
    return ClsiMetrics.instance;
  }

  public record(sample: CompileMetricSample): void {
    this.totalCompiles++;

    if (sample.isCached) {
      this.cacheHits++;
    } else {
      this.cacheMisses++;
    }

    if (sample.isTimeout) {
      this.timeouts++;
    }

    if (sample.success) {
      this.successfulCompiles++;
      if (sample.pdfSizeBytes) {
        this.totalPdfBytes += sample.pdfSizeBytes;
      }
    } else {
      this.failedCompiles++;
    }

    const engineKey = sample.engine.toLowerCase();
    const existing = this.durationsByEngine.get(engineKey) || {
      count: 0,
      totalMs: 0,
      minMs: Infinity,
      maxMs: 0,
    };

    existing.count++;
    existing.totalMs += sample.durationMs;
    existing.minMs = Math.min(existing.minMs, sample.durationMs);
    existing.maxMs = Math.max(existing.maxMs, sample.durationMs);

    this.durationsByEngine.set(engineKey, existing);
  }

  public getSummary() {
    const engineStats: Record<
      string,
      { count: number; avgMs: number; minMs: number; maxMs: number }
    > = {};

    for (const [engine, stats] of this.durationsByEngine.entries()) {
      engineStats[engine] = {
        count: stats.count,
        avgMs: stats.count > 0 ? Math.round(stats.totalMs / stats.count) : 0,
        minMs: stats.minMs === Infinity ? 0 : stats.minMs,
        maxMs: stats.maxMs,
      };
    }

    return {
      totalCompiles: this.totalCompiles,
      successfulCompiles: this.successfulCompiles,
      failedCompiles: this.failedCompiles,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheHitRate:
        this.totalCompiles > 0
          ? Math.round((this.cacheHits / this.totalCompiles) * 100) / 100
          : 0,
      timeouts: this.timeouts,
      totalPdfBytes: this.totalPdfBytes,
      engineStats,
    };
  }

  public toPrometheus(): string {
    const lines: string[] = [
      '# HELP clsi_compiles_total Total number of compilation requests',
      '# TYPE clsi_compiles_total counter',
      `clsi_compiles_total{status="success"} ${this.successfulCompiles}`,
      `clsi_compiles_total{status="failure"} ${this.failedCompiles}`,
      '',
      '# HELP clsi_cache_requests_total Cache hit and miss counters',
      '# TYPE clsi_cache_requests_total counter',
      `clsi_cache_requests_total{result="hit"} ${this.cacheHits}`,
      `clsi_cache_requests_total{result="miss"} ${this.cacheMisses}`,
      '',
      '# HELP clsi_timeouts_total Total number of timed-out compilations',
      '# TYPE clsi_timeouts_total counter',
      `clsi_timeouts_total ${this.timeouts}`,
      '',
      '# HELP clsi_pdf_output_bytes_total Total size in bytes of generated PDFs',
      '# TYPE clsi_pdf_output_bytes_total counter',
      `clsi_pdf_output_bytes_total ${this.totalPdfBytes}`,
    ];

    for (const [engine, stats] of this.durationsByEngine.entries()) {
      const avg = stats.count > 0 ? stats.totalMs / stats.count : 0;
      lines.push(
        `# HELP clsi_compile_duration_ms_avg Average compilation duration in ms for ${engine}`,
        `# TYPE clsi_compile_duration_ms_avg gauge`,
        `clsi_compile_duration_ms_avg{engine="${engine}"} ${Math.round(avg)}`
      );
    }

    return lines.join('\n') + '\n';
  }
}
