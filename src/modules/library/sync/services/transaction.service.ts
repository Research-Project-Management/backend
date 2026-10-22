import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, LibraryChange, Tombstone, OutboxStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ChangeLogRepository } from '@/modules/library/sync/repositories/changelog.repository';
import { OutboxRepository } from '@/modules/library/sync/repositories/outbox.repository';
import {
  IUnitOfWork,
  TransactionHelpers,
  AppendChangeEntry,
  AppendChangeInput,
  RecordTombstoneEntry,
  RecordTombstoneInput,
  PublishOutboxInput,
} from '@/modules/library/core/ports/unit-of-work.port';
import { OutboxWorker } from './outbox.worker';

export type {
  AppendChangeEntry,
  AppendChangeInput,
  RecordTombstoneEntry,
  RecordTombstoneInput,
  PublishOutboxInput,
  TransactionHelpers,
};

@Injectable()
export class TransactionService implements IUnitOfWork {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changeLogRepo: ChangeLogRepository,
    @Optional() private readonly outboxWorker?: OutboxWorker,
    @Optional() private readonly outboxRepo?: OutboxRepository,
  ) {}

  async executeInTransaction<T>(
    operation: (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    const pendingOutboxEventIds: string[] = [];

    const result = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const helpers: TransactionHelpers = {
          appendChange: async (
            scope: { userId?: string; projectId?: string | null },
            entry: AppendChangeEntry,
          ) => {
            return this.changeLogRepo.appendChange(scope, entry, tx);
          },
          appendChangesBatch: async (
            scopeOrEntries:
              | { userId?: string; projectId?: string | null }
              | AppendChangeInput[],
            entries?: AppendChangeEntry[],
          ) => {
            const normalizedEntries: AppendChangeInput[] = Array.isArray(
              scopeOrEntries,
            )
              ? scopeOrEntries
              : (entries || []).map((e) => ({
                  ...e,
                  userId: scopeOrEntries.userId,
                  projectId: scopeOrEntries.projectId,
                }));
            return this.changeLogRepo.appendChangesBatch(normalizedEntries, tx);
          },
          recordTombstone: async (
            scope: { userId?: string; projectId?: string | null },
            entry: RecordTombstoneEntry,
          ) => {
            return this.changeLogRepo.recordTombstone(scope, entry, tx);
          },
          recordTombstonesBatch: async (
            scopeOrEntries:
              | { userId?: string; projectId?: string | null }
              | RecordTombstoneInput[],
            entries?: RecordTombstoneEntry[],
          ) => {
            const normalizedEntries: RecordTombstoneInput[] = Array.isArray(
              scopeOrEntries,
            )
              ? scopeOrEntries
              : (entries || []).map((e) => ({
                  ...e,
                  userId: scopeOrEntries.userId,
                  projectId: scopeOrEntries.projectId,
                }));
            return this.changeLogRepo.recordTombstonesBatch(
              normalizedEntries,
              tx,
            );
          },
          removeTombstone: async (
            scope: { userId?: string; projectId?: string | null },
            entityType: string,
            entityId: string,
          ) => {
            return this.changeLogRepo.removeTombstone(scope, entityType, entityId, tx);
          },
          removeTombstonesBatch: async (
            scope: { userId?: string; projectId?: string | null },
            entityType: string,
            entityIds: string[],
          ) => {
            return this.changeLogRepo.removeTombstonesBatch(scope, entityType, entityIds, tx);
          },
          publishOutbox: async (
            scope: { userId: string; projectId?: string | null },
            aggregateId: string,
            eventType: string,
            payload: unknown,
          ) => {
            const event = await tx.outboxEvent.create({
              data: {
                userId: scope.userId,
                projectId: scope.projectId || null,
                aggregateId,
                eventType,
                payload: payload ?? {},
                status: OutboxStatus.PENDING,
                retryCount: 0,
              },
            });
            pendingOutboxEventIds.push(event.id);
            return event;
          },
          publishOutboxBatch: async (
            scopeOrEvents:
              | { userId: string; projectId?: string | null }
              | PublishOutboxInput[],
            events?: Array<{
              aggregateId: string;
              eventType: string;
              payload: unknown;
              projectId?: string | null;
            }>,
          ) => {
            const normalizedEvents: PublishOutboxInput[] = Array.isArray(
              scopeOrEvents,
            )
              ? scopeOrEvents
              : (events || []).map((ev) => ({
                  userId: scopeOrEvents.userId,
                  projectId:
                    ev.projectId !== undefined
                      ? ev.projectId
                      : scopeOrEvents.projectId,
                  aggregateId: ev.aggregateId,
                  eventType: ev.eventType,
                  payload: ev.payload,
                }));
            if (normalizedEvents.length === 0) return [];
            if (this.outboxRepo) {
              const ids = await this.outboxRepo.publishOutboxBatch(
                normalizedEvents,
                tx,
              );
              pendingOutboxEventIds.push(...ids);
              return ids;
            }
            const data: Prisma.OutboxEventCreateManyInput[] =
              normalizedEvents.map((ev) => ({
                id: randomUUID(),
                userId: ev.userId || '',
                projectId: ev.projectId || null,
                aggregateId: ev.aggregateId,
                eventType: ev.eventType,
                payload: (ev.payload as Prisma.InputJsonValue) ?? {},
                status: OutboxStatus.PENDING,
                retryCount: 0,
              }));
            if (typeof tx.outboxEvent?.createMany === 'function') {
              await tx.outboxEvent.createMany({ data });
              const ids = data.map((d) => d.id!);
              pendingOutboxEventIds.push(...ids);
              return ids;
            }
            const createdIds: string[] = [];
            for (const row of data) {
              const created = await tx.outboxEvent.create({ data: row });
              createdIds.push(created.id);
            }
            pendingOutboxEventIds.push(...createdIds);
            return createdIds;
          },
        };

        return operation(tx, helpers);
      },
      {
        maxWait: options?.maxWait ?? 10000,
        timeout: options?.timeout ?? 30000,
      },
    );

    if (pendingOutboxEventIds.length > 0 && this.outboxWorker) {
      void this.outboxWorker.notifyEvents(pendingOutboxEventIds);
    }

    return result;
  }

  async getChangesSince(
    scope: { userId?: string; projectId?: string | null },
    sinceSeq: bigint = BigInt(0),
    limit: number = 100,
  ): Promise<LibraryChange[]> {
    return this.changeLogRepo.getChangesSince(scope, sinceSeq, limit);
  }

  async getTombstonesSince(
    scope: { userId?: string; projectId?: string | null },
    sinceSeq?: bigint,
    limit: number = 100,
  ): Promise<Tombstone[]> {
    return this.changeLogRepo.getTombstonesSince(scope, sinceSeq, limit);
  }

  async getMinRetainedSequence(
    scope: { userId?: string; projectId?: string | null },
  ): Promise<bigint | null> {
    return this.changeLogRepo.getMinRetainedSequence(scope);
  }

  async getLatestSequence(
    scope: { userId?: string; projectId?: string | null },
  ) {
    return this.changeLogRepo.getLatestSequence(scope);
  }
}
