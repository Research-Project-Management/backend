export type SubmissionKind =
  'IDENTIFIER' | 'RECORD' | 'URL' | 'FILE' | 'CONNECTOR';

export type IdentifierType = 'DOI' | 'PMID' | 'ARXIV' | 'ISBN';
export type RecordFormat =
  'BIBTEX' | 'RIS' | 'CSL_JSON' | 'ENDNOTE_XML' | 'MODS' | 'REFER';

export interface IdentifierSubmissionInput {
  kind: 'IDENTIFIER';
  identifierType: IdentifierType;
  value: string;
}

export interface RecordSubmissionInput {
  kind: 'RECORD';
  format: RecordFormat;
  content?: string;
  isOffloaded?: boolean;
  fileId?: string;
  storageKey?: string;
  byteSize?: number;
  uncompressedSize?: number;
}

export interface UrlSubmissionInput {
  kind: 'URL';
  url: string;
  previewToken?: string;
  filename?: string;
  size?: number;
}

export interface FileSubmissionInput {
  kind: 'FILE';
  fileId: string;
  filename?: string;
  size?: number;
}

export interface ConnectorSubmissionInput {
  kind: 'CONNECTOR';
  connectionId: string;
  externalObjectId: string;
  externalVersion: string;
}

export type SubmissionPayload =
  | IdentifierSubmissionInput
  | RecordSubmissionInput
  | UrlSubmissionInput
  | FileSubmissionInput
  | ConnectorSubmissionInput;

export interface IngestionSubmissionEnvelope {
  projectId?: string;
  scopeId?: string;
  userId?: string;
  idempotencyKey?: string;
  payload: SubmissionPayload;
  collectionIds?: string[];
  tagIds?: string[];
  overrides?: Record<string, unknown>;
  contractVersion?: string;
}

export interface IngestionAcceptedResult {
  runId: string;
  statusUrl: string;
  acceptedAt: string;
  requestHash: string;
  status:
    | 'PENDING'
    | 'RUNNING'
    | 'COMPLETED'
    | 'FAILED_FINAL'
    | 'FAILED_RETRYABLE'
    | (string & {});
  existingItemId?: string;
  deduplicated?: boolean;
}

export type IngestionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'CANCELLED'
  | 'STALLED';

export interface IngestionStageSnapshot {
  id: string;
  ingestionRunId: string;
  stageName: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string | null;
  outputSnapshot?: unknown;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
  executedAt: Date;
}

export interface IngestionCandidateSnapshot {
  id: string;
  ingestionRunId: string;
  sourceProvider: string;
  sourceRecordId?: string | null;
  confidenceScore: number;
  metadataPayload: unknown;
  rawEvidenceRef?: string | null;
  fetchedAt: Date;
}

export interface IngestionDecisionSnapshot {
  id: string;
  ingestionRunId: string;
  decisionType: string;
  decisionReason: string;
  proposedItem: unknown;
  fieldDecisions?: unknown;
  duplicateMatch?: unknown;
  decidedAt: Date;
}

export interface IngestionReviewCaseSnapshot {
  id: string;
  userId?: string | null;
  projectId?: string | null;
  ingestionRunId: string;
  targetItemId?: string | null;
  reason: string;
  evidence?: unknown;
  options?: unknown;
  assignedToId?: string | null;
  status: string;
  resolution?: string | null;
  createdAt: Date;
  resolvedAt?: Date | null;
}

export interface IngestionRunSnapshot {
  id: string;
  projectId: string;
  scopeId?: string;
  sourceType: string;
  status: IngestionStatus;
  currentStage?: string | null;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  startedAt: Date;
  completedAt?: Date | null;
  lastError?: string | null;
  itemId?: string | null;
  item?: Record<string, unknown> | null;
  stages: IngestionStageSnapshot[];
  candidates: IngestionCandidateSnapshot[];
  decisions: IngestionDecisionSnapshot[];
  reviews?: IngestionReviewCaseSnapshot[];
  errors: unknown[];
}

export interface DuplicateClusterItemSnapshot {
  id: string;
  title: string;
  itemType?: string;
  type?: string;
  doi?: string;
  isbn?: string | null;
  issn?: string | null;
  pmid?: string | null;
  arxivId?: string | null;
  year?: number | null;
  publicationTitle?: string | null;
  publisher?: string | null;
  abstract?: string | null;
  abstractNote?: string | null;
  url?: string | null;
  authors?: string[];
  creators?: unknown[];
  citationKey?: string;
  collectionId?: string | null;
  collections?: unknown[];
  tags?: unknown[];
  attachments?: unknown[];
  notes?: unknown[];
  extra?: string | null;
  extraFields?: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface DuplicateClusterResult {
  clusterId: string;
  matchReason: 'EXACT_DOI' | 'FUZZY_TITLE_YEAR_AUTHOR' | (string & {});
  confidence: number;
  recommendedMasterId?: string;
  items: DuplicateClusterItemSnapshot[];
}

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
  status?: 'retracted' | 'clean' | 'unknown';
  nature?: RetractionNature;
  details?: RetractionDetails;
  checkedAt: Date;
}

export interface QualityAuditReport {
  totalItems: number;
  averageQualityScore: number;
  healthReport: {
    missingDoi: number;
    missingAbstract: number;
    missingYear: number;
  };
}
