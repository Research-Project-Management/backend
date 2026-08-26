export interface BusinessAuditEvent {
  id: string;
  workspaceId: string;
  userId: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  timestamp: string;
}

export interface StageMetricRecord {
  stage: string;
  durationMs: number;
  success: boolean;
  timestamp: string;
}

export interface CoreMetricSummary {
  ingestion: {
    totalRuns: number;
    failures: number;
    avgDurationMs: number;
    stageBreakdown: Record<
      string,
      { count: number; avgDurationMs: number; failures: number }
    >;
  };
  citations: {
    totalRenders: number;
    cacheHitRatio: number;
    avgRenderMs: number;
  };
  searches: {
    totalSearches: number;
    avgSearchMs: number;
  };
  cache: {
    metadata: { hits: number; misses: number; hitRatio: number };
    citation: { hits: number; misses: number; hitRatio: number };
  };
}
