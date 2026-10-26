import { CreatorCreditInput } from '@/modules/library/core/types/bibliographic.types';

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

export type IngestionCommand =
  | {
      source: 'doi';
      projectId?: string;
      scopeId?: string;
      doi: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
      overrides?: Record<string, unknown>;
    }
  | {
      source: 'arxiv';
      projectId?: string;
      scopeId?: string;
      arxivId: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
      overrides?: Record<string, unknown>;
    }
  | {
      source: 'pmid';
      projectId?: string;
      scopeId?: string;
      pmid: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
      overrides?: Record<string, unknown>;
    }
  | {
      source: 'isbn';
      projectId?: string;
      scopeId?: string;
      isbn: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
      overrides?: Record<string, unknown>;
    }
  | {
      source: 'url';
      projectId?: string;
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
      projectId?: string;
      scopeId?: string;
      content: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
    }
  | {
      source: 'ris';
      projectId?: string;
      scopeId?: string;
      content: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
    }
  | {
      source: 'csl_json';
      projectId?: string;
      scopeId?: string;
      content: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
    }
  | {
      source: 'pdf';
      projectId?: string;
      scopeId?: string;
      fileId?: string;
      filename?: string;
      userId?: string;
      collectionId?: string;
      overrides?: Record<string, unknown>;
      idempotencyKey?: string;
    }
  | {
      source: 'zotero';
      projectId?: string;
      scopeId?: string;
      connectionId?: string;
      externalItemKey?: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
    }
  | {
      source: string;
      projectId?: string;
      scopeId?: string;
      content?: string;
      doi?: string;
      arxivId?: string;
      pmid?: string;
      isbn?: string;
      url?: string;
      fileId?: string;
      filename?: string;
      connectionId?: string;
      externalItemKey?: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
      overrides?: Record<string, unknown>;
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
  item?: Record<string, unknown> | null;
  stages: IngestionStage[];
  reviews?: IngestionReviewCase[];
  errors: unknown[];
}
