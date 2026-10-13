/**
 * backend/scripts/benchmark/types.ts
 *
 * Unified data models and metric interfaces for the Empirical Accuracy Benchmark.
 */

export interface BenchmarkLinkSample {
  index: number;
  url: string;
  publisher: string;
  domain: string;
  doi?: string;
  title: string;
  year?: number;
  isOpenAccess: boolean;
}

export interface BenchmarkPaperSample {
  index: number;
  filename: string;
  filepath: string;
  title: string;
  doi?: string;
  publisher: string;
  sizeBytes: number;
  downloadedAt: string;
  year?: number;
}

export interface ExtractedMetadata {
  title?: string;
  doi?: string;
  authors?: string[];
  year?: number;
  journal?: string;
  abstract?: string;
  publisher?: string;
  engineUsed: string;
  executionMs: number;
  rawError?: string;
  wafBlocked?: boolean;
}

export interface MetricScore {
  titleTokenF1: number;
  titleLevenshtein: number;
  doiExactMatch: boolean;
  authorJaccard: number;
  yearMatch: boolean;
  completenessScore: number; // 0.0 to 1.0
  overallAccuracy: number;    // Weighted aggregate score
}

export interface ItemComparisonResult {
  sampleId: string | number;
  type: 'LINK' | 'PAPER';
  targetIdentifier: string;
  domainOrPublisher: string;
  groundTruth: {
    title: string;
    doi?: string;
    year?: number;
  };
  legacy: {
    extracted: ExtractedMetadata;
    score: MetricScore;
  };
  current: {
    extracted: ExtractedMetadata;
    score: MetricScore;
  };
}

export interface AggregateStats {
  sampleCount: number;
  titleMeanF1: number;
  titleMeanLevenshtein: number;
  doiAccuracyPercent: number;
  yearAccuracyPercent: number;
  authorMeanJaccard: number;
  meanCompletenessScore: number;
  overallAccuracyScore: number;
  wafBypassRatePercent?: number;
  meanLatencyMs: number;
}

export interface BenchmarkFinalReport {
  timestamp: string;
  sampleConfig: {
    requestedSamples: number;
    evaluatedLinks: number;
    evaluatedPapers: number;
  };
  summary: {
    links: {
      legacy: AggregateStats;
      current: AggregateStats;
      improvementPercent: number;
    };
    papers: {
      legacy: AggregateStats;
      current: AggregateStats;
      improvementPercent: number;
    };
    overall: {
      legacyAccuracy: number;
      currentAccuracy: number;
      absoluteGain: number;
    };
  };
  publisherBreakdown: Record<string, {
    count: number;
    legacyAccuracy: number;
    currentAccuracy: number;
    legacyWafBlockedCount: number;
    currentWafBlockedCount: number;
  }>;
  detailedComparisons: ItemComparisonResult[];
}
