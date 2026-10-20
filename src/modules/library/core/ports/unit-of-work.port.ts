import type {
  Prisma,
  LibraryChange,
  Tombstone,
  OutboxEvent,
} from '@prisma/client';

export interface AppendChangeEntry {
  entityType: string;
  entityId: string;
  action: 'create' | 'update' | 'delete' | (string & {});
  version: number;
  data?: unknown;
}

export interface AppendChangeInput extends AppendChangeEntry {
  userId?: string;
  projectId?: string | null;
}

export interface RecordTombstoneEntry {
  entityType: string;
  entityId: string;
  deletedById?: string;
}

export interface RecordTombstoneInput extends RecordTombstoneEntry {
  userId?: string;
  projectId?: string | null;
}

export interface PublishOutboxInput {
  userId: string;
  projectId?: string | null;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

export interface TransactionHelpers {
  appendChange(
    scope: { userId?: string; projectId?: string | null },
    entry: AppendChangeEntry,
  ): Promise<LibraryChange>;
  appendChangesBatch(
    scopeOrEntries:
      | { userId?: string; projectId?: string | null }
      | AppendChangeInput[],
    entries?: AppendChangeEntry[],
  ): Promise<number>;
  recordTombstone(
    scope: { userId?: string; projectId?: string | null },
    entry: RecordTombstoneEntry,
  ): Promise<Tombstone>;
  recordTombstonesBatch(
    scopeOrEntries:
      | { userId?: string; projectId?: string | null }
      | RecordTombstoneInput[],
    entries?: RecordTombstoneEntry[],
  ): Promise<number>;
  removeTombstone?(
    scope: { userId?: string; projectId?: string | null },
    entityType: string,
    entityId: string,
  ): Promise<number>;
  removeTombstonesBatch?(
    scope: { userId?: string; projectId?: string | null },
    entityType: string,
    entityIds: string[],
  ): Promise<number>;
  publishOutbox(
    scope: { userId: string; projectId?: string | null },
    aggregateId: string,
    eventType: string,
    payload: unknown,
  ): Promise<OutboxEvent>;
  publishOutboxBatch(
    scopeOrEvents:
      | { userId: string; projectId?: string | null }
      | PublishOutboxInput[],
    events?: Array<{
      aggregateId: string;
      eventType: string;
      payload: unknown;
      projectId?: string | null;
    }>,
  ): Promise<string[]>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export interface IUnitOfWork {
  executeInTransaction<T>(
    operation: (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}
