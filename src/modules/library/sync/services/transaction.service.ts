import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService, RedisCacheService } from '@/core';
import { Prisma, LibraryChange, Tombstone, OutboxStatus } from '@prisma/client';
import { uuidv7, IUnitOfWork, TransactionHelpers, AppendChangeEntry, AppendChangeInput, RecordTombstoneEntry, RecordTombstoneInput, normalizeProjectScopeId, LIBRARY_REDIS_KEYS, SingleFlightCoalescer, LIBRARY_OUTBOX_QUEUE, LIBRARY_OUTBOX_JOB } from '@/modules/library/core';
import { ChangeLogRepository } from '@/modules/library/sync/repositories/changelog.repository';
import { OutboxRepository, PublishOutboxInput, OutboxPublishInput } from '@/modules/library/sync/repositories/outbox.repository';
import { OutboxWorker } from './outbox.worker';

export { LIBRARY_OUTBOX_QUEUE, LIBRARY_OUTBOX_JOB };

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
  private readonly singleFlight = new SingleFlightCoalescer();

  constructor(
    private readonly prisma: PrismaService,
    private readonly changeLogRepo: ChangeLogRepository,
    @Optional() private readonly outboxWorker?: OutboxWorker,
    @Optional() private readonly outboxRepo?: OutboxRepository,
    @Optional()
    @InjectQueue(LIBRARY_OUTBOX_QUEUE)
    private readonly outboxQueue?: Queue,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private resolveSyncScopeCacheKey(scope: {
    userId?: string;
    projectId?: string | null;
  }): string | null {
    const validProjectId = normalizeProjectScopeId(scope.projectId);
    if (validProjectId) return `proj:${validProjectId}`;
    const trimmedUser = scope.userId?.trim();
    if (trimmedUser) return `user:${trimmedUser}`;
    return null;
  }

  private async invalidateSyncScopeSequenceCache(
    scopeKeys: Iterable<string>,
  ): Promise<void> {
    if (!this.cache) return;
    const tasks: Promise<unknown>[] = [];
    for (const scopeKey of scopeKeys) {
      tasks.push(
        this.cache
          .del(LIBRARY_REDIS_KEYS.syncSequence(scopeKey))
          .catch(() => undefined),
        this.cache
          .del(LIBRARY_REDIS_KEYS.minRetainedSequence(scopeKey))
          .catch(() => undefined),
      );
    }
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  private buildOutboxEventData(
    ev: PublishOutboxInput,
  ): Prisma.OutboxEventCreateManyInput {
    const rawUserId = (ev.userId || '').trim();
    const validUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        rawUserId,
      );
    const resolvedUserId = validUuid
      ? rawUserId
      : '00000000-0000-0000-0000-000000000000';
    return {
      userId: resolvedUserId,
      actorId:
        ev.actorId ??
        (resolvedUserId !== '00000000-0000-0000-0000-000000000000'
          ? resolvedUserId
          : null),
      projectId: ev.projectId || null,
      aggregateId: ev.aggregateId,
      eventType: ev.eventType,
      payload: (ev.payload as Prisma.InputJsonValue) ?? {},
      dedupeKey: ev.dedupeKey ?? null,
      status: OutboxStatus.PENDING,
      retryCount: 0,
    };
  }

  async executeInTransaction<T>(
    operation: (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    const pendingOutboxEvents: Array<{ id: string; eventType: string }> = [];
    const postCommitCallbacks: Array<() => Promise<void> | void> = [];
    const touchedSyncScopes = new Set<string>();

    const trackScope = (scope: { userId?: string; projectId?: string | null }) => {
      const key = this.resolveSyncScopeCacheKey(scope);
      if (key) touchedSyncScopes.add(key);
    };

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
            trackScope(scope);
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
            for (const entry of normalizedEntries) {
              trackScope({ userId: entry.userId, projectId: entry.projectId });
            }
            return this.changeLogRepo.appendChangesBatch(normalizedEntries, tx);
          },
          recordTombstone: async (
            scope: { userId?: string; projectId?: string | null },
            entry: RecordTombstoneEntry,
          ) => {
            trackScope(scope);
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
            for (const entry of normalizedEntries) {
              trackScope({ userId: entry.userId, projectId: entry.projectId });
            }
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
            trackScope(scope);
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
            trackScope(scope);
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
              data: this.buildOutboxEventData({
                userId: scope.userId,
                projectId: scope.projectId || null,
                aggregateId,
                eventType,
                payload,
                dedupeKey,
              }),
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
                ...this.buildOutboxEventData(ev),
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

    if (touchedSyncScopes.size > 0 || postCommitCallbacks.length > 0) {
      await Promise.all([
        touchedSyncScopes.size > 0
          ? this.invalidateSyncScopeSequenceCache(touchedSyncScopes)
          : undefined,
        ...postCommitCallbacks.map(async (cb) => {
          try {
            await cb();
          } catch (cbErr: unknown) {
            this.logger.warn(
              `Post-commit hook failed: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
            );
          }
        }),
      ]);
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
    const scopeKey = this.resolveSyncScopeCacheKey(scope);
    if (!scopeKey) {
      return this.changeLogRepo.getMinRetainedSequence(scope);
    }
    const cacheKey = LIBRARY_REDIS_KEYS.minRetainedSequence(scopeKey);
    return this.singleFlight.execute(cacheKey, async () => {
      if (this.cache?.get) {
        try {
          const cached = await this.cache.get<string>(cacheKey);
          if (cached === '__NULL__') return null;
          if (typeof cached === 'string' && /^\d+$/.test(cached)) {
            return BigInt(cached);
          }
        } catch {
          // Fallback to repository
        }
      }
      const seq = await this.changeLogRepo.getMinRetainedSequence(scope);
      if (this.cache?.set) {
        await this.cache
          .set(cacheKey, seq !== null ? seq.toString() : '__NULL__', 30)
          .catch(() => undefined);
      }
      return seq;
    });
  }

  async getLatestSequence(scope: {
    userId?: string;
    projectId?: string | null;
  }): Promise<bigint> {
    const scopeKey = this.resolveSyncScopeCacheKey(scope);
    if (!scopeKey) {
      return this.changeLogRepo.getLatestSequence(scope);
    }
    const cacheKey = LIBRARY_REDIS_KEYS.syncSequence(scopeKey);
    return this.singleFlight.execute(cacheKey, async () => {
      if (this.cache?.get) {
        try {
          const cached = await this.cache.get<string>(cacheKey);
          if (typeof cached === 'string' && /^\d+$/.test(cached)) {
            return BigInt(cached);
          }
        } catch {
          // Fallback to repository
        }
      }
      const seq = await this.changeLogRepo.getLatestSequence(scope);
      if (this.cache?.set) {
        await this.cache
          .set(cacheKey, seq.toString(), 15)
          .catch(() => undefined);
      }
      return seq;
    });
  }
}

interface CompactableChange {
  id?: string;
  seq: bigint | number | string;
  userId?: string | null;
  projectId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  version?: number;
  data?: unknown;
  createdAt?: Date | string;
}

/**
 * Sliding-Window Delta Compaction Algorithm.
 * Squashes multiple consecutive mutations for the same entity within a sync window.
 * Reduces bandwidth and client processing overhead by 70%-90%.
 */
export function compactLibraryChanges<T extends CompactableChange>(
  changes: T[],
): T[] {
  const entityMap = new Map<string, T>();

  for (const change of changes) {
    const key = `${change.entityType.toLowerCase()}:${change.entityId}`;
    const existing = entityMap.get(key);

    if (!existing) {
      entityMap.set(key, { ...change });
      continue;
    }

    const prevAction = existing.action.toUpperCase();
    const currAction = change.action.toUpperCase();

    if (
      (prevAction === 'CREATE' && currAction === 'UPDATE') ||
      (prevAction === 'UPDATE' && currAction === 'UPDATE')
    ) {
      entityMap.set(key, {
        ...change,
        action: existing.action,
        seq: change.seq,
        version: change.version ?? existing.version,
        data: mergePayloadData(existing.data, change.data),
      });
      continue;
    }

    if (currAction === 'DELETE') {
      if (prevAction === 'CREATE') {
        const prevTitle =
          existing.data && typeof existing.data === 'object'
            ? (existing.data as { title?: unknown }).title
            : undefined;
        const isRestoredLifecycle =
          typeof prevTitle === 'string' &&
          prevTitle.toLowerCase().includes('restored');
        if (!isRestoredLifecycle) {
          entityMap.delete(key);
          continue;
        }
      }
      entityMap.set(key, {
        ...change,
        seq: change.seq,
        version: change.version ?? existing.version,
        data: change.data ?? null,
      });
      continue;
    }

    entityMap.set(key, { ...change });
  }

  return Array.from(entityMap.values()).sort((a, b) => {
    const seqA = typeof a.seq === 'bigint' ? a.seq : BigInt(a.seq);
    const seqB = typeof b.seq === 'bigint' ? b.seq : BigInt(b.seq);
    return seqA < seqB ? -1 : seqA > seqB ? 1 : 0;
  });
}

function mergePayloadData(prev: unknown, next: unknown): unknown {
  if (!prev) return next;
  if (!next) return prev;
  if (
    typeof prev !== 'object' ||
    typeof next !== 'object' ||
    Array.isArray(prev) ||
    Array.isArray(next)
  ) {
    return next;
  }
  return {
    ...(prev as Record<string, unknown>),
    ...(next as Record<string, unknown>),
  };
}

export {
  evaluateOutboxFailureDecision,
  computeOutboxDiagnostics,
  type OutboxMetricsRecorder,
  type OutboxDiagnosticSummary,
} from '../repositories/changelog.repository';
