import { IngestionStatus } from '@prisma/client';

export type IngestionSourceType = 'doi' | 'url' | 'bibtex' | 'pdf' | 'zotero';

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
        creators?: any[];
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
      userId?: string;
      filename?: string;
      fileUrl?: string;
      mimeType?: string;
      size?: number;
      buffer?: Buffer;
      fileHash?: string;
      fileId?: string;
      collectionId?: string;
      extractedMeta?: Record<string, any>;
      idempotencyKey?: string;
    }
  | {
      source: 'zotero';
      workspaceId: string;
      connectionId: string;
      externalItemKey: string;
      payload: unknown;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
    };

export interface IngestionResult {
  runId: string;
  status: 'completed' | 'processing' | 'failed';
  itemId?: string;
  attachmentIds: string[];
  deduplicated: boolean;
  item?: any;
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

export const UNIFIED_INGESTION_SERVICE = Symbol('UNIFIED_INGESTION_SERVICE');

export interface IUnifiedIngestionService {
  ingest(command: IngestionCommand): Promise<IngestionResult>;
  getRunStatus(runId: string): Promise<IngestionRunSnapshot>;
}
