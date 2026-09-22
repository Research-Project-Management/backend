import { CreatorCreditInput } from '../../../shared-kernel/types/bibliographic.types';

export interface IngestionStage {
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

export interface IngestionCandidate {
  id: string;
  ingestionRunId: string;
  sourceProvider: string;
  sourceRecordId?: string | null;
  confidenceScore: number;
  metadataPayload: unknown;
  rawEvidenceRef?: string | null;
  fetchedAt: Date;
}

export interface IngestionDecision {
  id: string;
  ingestionRunId: string;
  decisionType: string;
  decisionReason: string;
  proposedItem: unknown;
  fieldDecisions?: unknown;
  duplicateMatch?: unknown;
  decidedAt: Date;
}

export interface IngestionReviewCase {
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

export type IngestionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'CANCELLED'
  | 'STALLED'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

export type IngestionSourceType = 'doi' | 'url' | 'bibtex' | 'pdf';

export type IngestionCommand =
  | {
      source: 'doi';
      projectId: string;
      scopeId?: string;
      doi: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
      overrides?: Record<string, unknown>;
    }
  | {
      source: 'url';
      projectId: string;
      scopeId?: string;
      url: string;
      previewToken?: string;
      userId?: string;
      collectionId?: string;
      overrides?: {
        title?: string;
        abstract?: string;
        doi?: string;
        year?: number;
        publicationTitle?: string;
        itemType?: string;
        creators?: CreatorCreditInput[];
        tags?: string[];
        url?: string;
      };
      idempotencyKey?: string;
    }
  | {
      source: 'bibtex';
      projectId: string;
      scopeId?: string;
      content: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
    }
  | {
      source: 'pdf';
      projectId: string;
      scopeId?: string;
      fileId: string;
      filename?: string;
      userId?: string;
      collectionId?: string;
      overrides?: Record<string, unknown>;
      idempotencyKey?: string;
    };

export interface IngestionResult {
  runId: string;
  status: 'completed' | 'processing' | 'failed';
  itemId?: string;
  attachmentIds: string[];
  deduplicated: boolean;
  item?: unknown;
  errorCategory?: string;
  errorMessage?: string;
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
  item?: any;
  stages: IngestionStage[];
  candidates: IngestionCandidate[];
  decisions: IngestionDecision[];
  reviews?: IngestionReviewCase[];
  reviewCases?: IngestionReviewCase[];
  errors: unknown[];
}

export const INGESTION_PORT = Symbol('INGESTION_PORT');

export interface IngestionPort {
  ingest(command: IngestionCommand): Promise<IngestionResult>;
  getRunStatus(projectId: string, runId: string): Promise<IngestionRunSnapshot>;
}

export type {
  SubmissionKind,
  IdentifierType,
  RecordFormat,
  IdentifierSubmissionInput,
  RecordSubmissionInput,
  UrlSubmissionInput,
  FileSubmissionInput,
  ConnectorSubmissionInput,
  SubmissionPayload,
  IngestionSubmissionEnvelope,
} from './submission.types';

export type {
  FieldEvidence,
  MetadataCandidate,
  MetadataConflictDetail,
  ReconciliationDecision,
  DuplicateMatchResult,
} from './metadata-candidate.types';
