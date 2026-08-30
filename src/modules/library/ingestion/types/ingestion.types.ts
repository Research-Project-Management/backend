import { IngestionStatus } from '@prisma/client';
import { CreatorInput } from '../../catalog/types/item.types';

export type IngestionSourceType = 'doi' | 'url' | 'bibtex' | 'pdf';

export type IngestionCommand =
  | {
      source: 'doi';
      workspaceId: string;
      doi: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
    }
  | {
      source: 'url';
      workspaceId: string;
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
        creators?: CreatorInput[];
        tags?: string[];
        url?: string;
      };
      idempotencyKey?: string;
    }
  | {
      source: 'bibtex';
      workspaceId: string;
      content: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
    }
  | {
      source: 'pdf';
      workspaceId: string;
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
  workspaceId: string;
  sourceType: string;
  status: IngestionStatus;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  startedAt: Date;
  completedAt?: Date | null;
}

export const INGESTION_PORT = Symbol('INGESTION_PORT');

export interface IngestionPort {
  ingest(command: IngestionCommand): Promise<IngestionResult>;
  getRunStatus(
    workspaceId: string,
    runId: string,
  ): Promise<IngestionRunSnapshot>;
}
