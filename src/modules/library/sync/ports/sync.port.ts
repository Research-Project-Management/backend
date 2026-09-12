export const SYNC_PORT = Symbol('SYNC_PORT');

export interface SyncItemSnapshot {
  id: string;
  workspaceId: string;
  title: string;
  abstract?: string | null;
  year?: number | null;
  doi?: string | null;
  citationKey?: string | null;
  publicationTitle?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  issn?: string | null;
  isbn?: string | null;
  url?: string | null;
  tags: string[];
}

export interface SyncItemSummary {
  id: string;
  title: string;
  itemType?: string | null;
  version?: number;
  updatedAt?: Date;
}

export interface GetSyncItemSnapshotQuery {
  workspaceId: string;
  itemId: string;
}

export interface GetSyncItemSnapshotsQuery {
  workspaceId: string;
  itemIds: string[];
}

export * from '../../common/types/sync.types';
import type {
  UpsertSyncCollectionCommand,
  UpsertSyncItemCommand,
  UpsertSyncAttachmentCommand,
  UpsertSyncNoteCommand,
  UpsertSyncAnnotationCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../../common/types/sync.types';

export interface PublishIntegrationEventCommand<T = Record<string, unknown>> {
  workspaceId: string;
  aggregateId: string;
  eventType: string;
  dedupeKey?: string;
  payload: T;
}

export interface BaseExternalSyncOperation {
  operationId?: string;
  parentRef?: string;
}

export type ExternalSyncOperation =
  | ({
      op: 'upsertCollection';
      command: UpsertSyncCollectionCommand;
    } & BaseExternalSyncOperation)
  | ({
      op: 'upsertItem';
      command: UpsertSyncItemCommand;
    } & BaseExternalSyncOperation)
  | ({
      op: 'upsertAttachment';
      command: UpsertSyncAttachmentCommand;
    } & BaseExternalSyncOperation)
  | ({
      op: 'upsertNote';
      command: UpsertSyncNoteCommand;
    } & BaseExternalSyncOperation)
  | ({
      op: 'upsertAnnotation';
      command: UpsertSyncAnnotationCommand;
    } & BaseExternalSyncOperation)
  | ({
      op: 'deleteEntity';
      command: DeleteSyncEntityCommand;
    } & BaseExternalSyncOperation);

export interface ExternalSyncBatchOperationResult {
  operationId?: string;
  op: string;
  result?: UpsertSyncEntityResult;
  deleted?: boolean;
}

export interface ApplyExternalSyncBatchCommand {
  workspaceId: string;
  idempotencyKey?: string;
  operations: ExternalSyncOperation[];
}

export interface ExternalSyncBatchResult {
  results: ExternalSyncBatchOperationResult[];
}

export interface IntegrationOutboxEvent<T = Record<string, unknown>> {
  id: string;
  workspaceId: string;
  aggregateId: string;
  eventType: string;
  payload: T;
  dedupeKey?: string | null;
  createdAt: Date;
}

export type IntegrationEventHandler = (
  event: IntegrationOutboxEvent,
) => Promise<void>;

export interface SyncPort {
  getItemSnapshot(
    query: GetSyncItemSnapshotQuery,
  ): Promise<SyncItemSnapshot | null>;

  getItemSnapshots(
    query: GetSyncItemSnapshotsQuery,
  ): Promise<SyncItemSummary[]>;

  upsertCollection(
    command: UpsertSyncCollectionCommand,
  ): Promise<UpsertSyncEntityResult>;

  upsertItem(
    command: UpsertSyncItemCommand,
  ): Promise<UpsertSyncEntityResult>;

  upsertAttachment(
    command: UpsertSyncAttachmentCommand,
  ): Promise<UpsertSyncEntityResult>;

  upsertNote(command: UpsertSyncNoteCommand): Promise<UpsertSyncEntityResult>;

  upsertAnnotation(
    command: UpsertSyncAnnotationCommand,
  ): Promise<UpsertSyncEntityResult>;

  deleteEntity(command: DeleteSyncEntityCommand): Promise<void>;

  applyExternalSyncBatch(
    command: ApplyExternalSyncBatchCommand,
    userId?: string,
  ): Promise<ExternalSyncBatchResult>;

  publishIntegrationEvent(
    command: PublishIntegrationEventCommand,
  ): Promise<{ id: string }>;

  registerIntegrationEventHandler(
    eventType: string,
    handler: IntegrationEventHandler,
  ): void;
}
