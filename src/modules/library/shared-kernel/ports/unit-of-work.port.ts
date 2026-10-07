import { Prisma, LibraryChange, Tombstone, OutboxEvent } from '@prisma/client';

export const UNIT_OF_WORK_PORT = Symbol('UNIT_OF_WORK_PORT');

export interface AppendChangeEntry {
  entityType: string;
  entityId: string;
  action: 'create' | 'update' | 'delete' | string;
  version: number;
  data?: any;
}

export interface RecordTombstoneEntry {
  entityType: string;
  entityId: string;
  deletedById?: string;
}

export interface TransactionHelpers {
  appendChange(
    scope: { userId?: string; projectId?: string } | string,
    entry: AppendChangeEntry,
  ): Promise<LibraryChange>;
  recordTombstone(
    scope: { userId?: string; projectId?: string } | string,
    entry: RecordTombstoneEntry,
  ): Promise<Tombstone>;
  publishOutbox(
    scope: { userId: string; projectId?: string | null } | string,
    aggregateId: string,
    eventType: string,
    payload: any,
  ): Promise<OutboxEvent>;
}

export interface IUnitOfWork {
  executeInTransaction<T>(
    operation: (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}

export abstract class TransactionService implements IUnitOfWork {
  abstract executeInTransaction<T>(
    operation: (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}
