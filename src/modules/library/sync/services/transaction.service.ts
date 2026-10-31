import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '@/core';
import { Prisma, LibraryChange, Tombstone, OutboxStatus } from '@prisma/client';
import { uuidv7 } from '@/modules/library/core';
import { ChangeLogRepository } from '@/modules/library/sync/repositories/changelog.repository';
import {
  LIBRARY_OUTBOX_JOB,
  LIBRARY_OUTBOX_QUEUE,
} from '@/modules/library/sync/domain/outbox.domain';
import {
  IUnitOfWork,
  TransactionHelpers,
  AppendChangeEntry,
  AppendChangeInput,
  RecordTombstoneEntry,
  RecordTombstoneInput,
} from '@/modules/library/core/ports/unit-of-work.port';
import {
  OutboxRepository,
  PublishOutboxInput,
  OutboxPublishInput,
} from '@/modules/library/sync/repositories/outbox.repository';
import { OutboxWorker } from './outbox.worker';

export type {
  TransactionHelpers,
  AppendChangeEntry,
  AppendChangeInput,
  RecordTombstoneEntry,
  RecordTombstoneInput,
  PublishOutboxInput,
  OutboxPublishInput,
};

@Injectable()
export class TransactionService implements IUnitOfWork {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly changeLogRepo: ChangeLogRepository,
    @Optional() private readonly outboxWorker?: OutboxWorker,
    @Optional() private readonly outboxRepo?: OutboxRepository,
    @Optional()
    @InjectQueue(LIBRARY_OUTBOX_QUEUE)
    private readonly outboxQueue?: Queue,
  ) {}

  async executeInTransaction<T>(
    operation: (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    const pendingOutboxEvents: Array<{ id: string; eventType: string }> = [];
    const postCommitCallbacks: Array<() => Promise<void> | void> = [];

    const result = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const helpers: TransactionHelpers = {
          onAfterCommit: (callback: () => Promise<void> | void) => {
            postCommitCallbacks.push(callback);
          },
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
            return this.changeLogRepo.removeTombstone(
              scope,
              entityType,
              entityId,
              tx,
            );
          },
          removeTombstonesBatch: async (
            scope: { userId?: string; projectId?: string | null },
            entityType: string,
            entityIds: string[],
          ) => {
            return this.changeLogRepo.removeTombstonesBatch(
              scope,
              entityType,
              entityIds,
              tx,
            );
          },
          publishOutbox: async (
            scope: {
              userId: string;
              projectId?: string | null;
              dedupeKey?: string | null;
            },
            aggregateId: string,
            eventType: string,
            payload: unknown,
            options?: { dedupeKey?: string | null },
          ) => {
            const rawUserId = (scope.userId || '').trim();
            const normalizedUserId =
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                rawUserId,
              )
                ? rawUserId
                : '00000000-0000-0000-0000-000000000000';
            const dedupeKey =
              options?.dedupeKey ??
              scope.dedupeKey ??
              (payload &&
              typeof payload === 'object' &&
              !Array.isArray(payload) &&
              typeof (payload as Record<string, unknown>).dedupeKey === 'string'
                ? ((payload as Record<string, unknown>).dedupeKey as string)
                : null);
            const event = await tx.outboxEvent.create({
              data: {
                userId: normalizedUserId,
                projectId: scope.projectId || null,
                aggregateId,
                eventType,
                payload: payload ?? {},
                dedupeKey: dedupeKey ?? null,
                status: OutboxStatus.PENDING,
                retryCount: 0,
              },
            });
            pendingOutboxEvents.push({
              id: event.id,
              eventType: event.eventType,
            });
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
              dedupeKey?: string | null;
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
                  dedupeKey: ev.dedupeKey ?? null,
                }));
            if (normalizedEvents.length === 0) return [];
            if (this.outboxRepo) {
              const ids = await this.outboxRepo.publishOutboxBatch(
                normalizedEvents,
                tx,
              );
              normalizedEvents.forEach((ev, idx) => {
                if (ids[idx]) {
                  pendingOutboxEvents.push({
                    id: ids[idx],
                    eventType: ev.eventType,
                  });
                }
              });
              return ids;
            }
            const data: Prisma.OutboxEventCreateManyInput[] =
              normalizedEvents.map((ev) => ({
                id: uuidv7(),
                userId:
                  ev.userId &&
                  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                    ev.userId.trim(),
                  )
                    ? ev.userId.trim()
                    : '00000000-0000-0000-0000-000000000000',
                projectId: ev.projectId || null,
                aggregateId: ev.aggregateId,
                eventType: ev.eventType,
                payload: (ev.payload as Prisma.InputJsonValue) ?? {},
                dedupeKey: ev.dedupeKey ?? null,
                status: OutboxStatus.PENDING,
                retryCount: 0,
              }));
            if (tx.outboxEvent?.createMany) {
              await tx.outboxEvent.createMany({ data });
              const ids = data.map((d) => d.id!);
              data.forEach((d) => {
                pendingOutboxEvents.push({ id: d.id!, eventType: d.eventType });
              });
              return ids;
            }
            const createdIds: string[] = [];
            for (const row of data) {
              const created = await tx.outboxEvent.create({ data: row });
              createdIds.push(created.id);
              pendingOutboxEvents.push({
                id: created.id,
                eventType: created.eventType,
              });
            }
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

    if (postCommitCallbacks.length > 0) {
      for (const cb of postCommitCallbacks) {
        try {
          await cb();
        } catch (cbErr: unknown) {
          this.logger.warn(
            `Post-commit hook failed: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
          );
        }
      }
    }

    if (pendingOutboxEvents.length > 0) {
      void this.dispatchPostCommitOutboxNotifications(
        pendingOutboxEvents,
      ).catch((err: unknown) => {
        this.logger.warn(
          `Post-commit outbox notification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    return result;
  }

  async dispatchPostCommitOutboxNotifications(
    events: Array<{ id: string; eventType: string }>,
  ): Promise<void> {
    if (!events || events.length === 0) return;

    if (this.outboxQueue) {
      try {
        await this.outboxQueue.addBulk(
          events.map((ev) => ({
            name: LIBRARY_OUTBOX_JOB,
            data: { eventId: ev.id, eventType: ev.eventType },
            opts: {
              jobId: ev.id,
              attempts: 5,
              backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: true,
            },
          })),
        );
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to bulk-enqueue outbox event(s) to BullMQ: ${msg}. Falling back to direct worker notification.`,
        );
      }
    }

    if (this.outboxWorker) {
      void this.outboxWorker
        .notifyEvents(events.map((e) => e.id))
        .catch((err: unknown) => {
          this.logger.warn(
            `Outbox worker notifyEvents failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
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

  async getMinRetainedSequence(scope: {
    userId?: string;
    projectId?: string | null;
  }): Promise<bigint | null> {
    return this.changeLogRepo.getMinRetainedSequence(scope);
  }

  async getLatestSequence(scope: {
    userId?: string;
    projectId?: string | null;
  }) {
    return this.changeLogRepo.getLatestSequence(scope);
  }
}
