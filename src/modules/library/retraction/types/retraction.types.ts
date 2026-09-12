export type RetractionNature =
  'retraction' | 'expression_of_concern' | 'correction' | 'manual';

export type RetractionSource =
  'crossref' | 'openalex' | 'retraction_watch' | 'manual';

export interface RetractionDetails {
  nature: RetractionNature;
  reason?: string;
  noticeUrl?: string;
  date?: string;
  source: RetractionSource;
}

export interface RetractionCheckResult {
  itemId: string;
  isRetracted: boolean;
  nature?: RetractionNature;
  details?: RetractionDetails;
  checkedAt: Date;
}

export interface RetractionStats {
  totalItems: number;
  checkedItems: number;
  retractedCount: number;
  expressionsOfConcernCount: number;
  manualCount: number;
}

export type WorkspaceRetractionStats = RetractionStats;
