import {
  IngestionStage,
  IngestionCandidate,
  IngestionDecision,
  IngestionReviewCase,
} from '@prisma/client';
import { CreatorCreditInput } from '../../items/types/items.types';

export type IngestionStatus =
  | 'pending'
  | 'processing'
  | 'extracting'
  | 'normalizing'
  | 'reconciling'
  | 'indexing'
  | 'completed'
  | 'failed'
  | 'review_required';

export type IngestionSourceType = 'doi' | 'url' | 'bibtex' | 'pdf';

export type IngestionCommand =
  | {
      source: 'doi';
      projectId: string;
      workspaceId?: string;
      doi: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
      overrides?: Record<string, unknown>;
    }
  | {
      source: 'url';
      projectId: string;
      workspaceId?: string;
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
      workspaceId?: string;
      content: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
    }
  | {
      source: 'pdf';
      projectId: string;
      workspaceId?: string;
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
  workspaceId?: string;
  sourceType: string;
  status: IngestionStatus;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  startedAt: Date;
  completedAt?: Date | null;
  lastError?: string | null;
  itemId?: string | null;
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
