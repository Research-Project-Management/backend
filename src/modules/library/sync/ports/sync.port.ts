export const SYNC_PORT = Symbol('SYNC_PORT');

export type SyncEntityType =
  'CatalogItem' | 'Collection' | 'CatalogAttachment' | 'Note' | 'Annotation';

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

export interface UpsertSyncCollectionCommand {
  workspaceId: string;
  userId: string;
  existingId?: string;
  name: string;
  description?: string;
  parentCollectionId?: string;
}

export interface UpsertSyncCatalogItemCommand {
  workspaceId: string;
  userId: string;
  existingId?: string;
  title: string;
  abstract?: string;
  year?: number;
  doi?: string;
  citationKey?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  isbn?: string;
  url?: string;
  itemType?: string;
  filename?: string;
  fileUrl?: string;
  tags?: string[];
}

export interface UpsertSyncAttachmentCommand {
  workspaceId: string;
  existingId?: string;
  catalogItemId?: string;
  filename: string;
  url: string;
  mimeType: string;
  fileHash?: string;
  attachmentType?: string;
  size?: number;
}

export interface UpsertSyncNoteCommand {
  workspaceId: string;
  userId: string;
  existingId?: string;
  catalogItemId?: string;
  title: string;
  contentMd: string;
  tags?: string[];
}

export interface UpsertSyncAnnotationCommand {
  workspaceId: string;
  userId: string;
  existingId?: string;
  attachmentId?: string;
  pageIndex: number;
  quoteText?: string;
  comment?: string;
  color?: string;
  type?: string;
}

export interface DeleteSyncEntityCommand {
  workspaceId: string;
  entityType: SyncEntityType;
  entityId: string;
  reason?: string;
  publishOutboxEventType?: string;
  publishOutboxPayload?: Record<string, unknown>;
}

export interface PublishIntegrationEventCommand<T = Record<string, unknown>> {
  workspaceId: string;
  aggregateId: string;
  eventType: string;
  dedupeKey?: string;
  payload: T;
}

export interface UpsertSyncEntityResult {
  id: string;
  isNew: boolean;
  version: number;
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
      op: 'upsertCatalogItem';
      command: UpsertSyncCatalogItemCommand;
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

  upsertCatalogItem(
    command: UpsertSyncCatalogItemCommand,
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
  ): Promise<ExternalSyncBatchResult>;

  publishIntegrationEvent(
    command: PublishIntegrationEventCommand,
  ): Promise<{ id: string }>;

  registerIntegrationEventHandler(
    eventType: string,
    handler: IntegrationEventHandler,
  ): void;
}
