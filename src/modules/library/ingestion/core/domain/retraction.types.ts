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

export type RetractionLookupResult =
  | { status: 'retracted'; details: RetractionDetails }
  | { status: 'clean' }
  | { status: 'unknown' };

export interface RetractionCheckResult {
  itemId: string;
  isRetracted: boolean;
  /** `unknown` = could not be verified; stored status was left untouched. */
  status?: 'retracted' | 'clean' | 'unknown';
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
