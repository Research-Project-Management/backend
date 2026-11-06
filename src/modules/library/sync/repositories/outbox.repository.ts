import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { OutboxStatus, OutboxEvent, Prisma } from '@prisma/client';
import { uuidv7 } from '@/modules/library/core';
import type { ChangeLogRepository } from './changelog.repository';
import {
  evaluateOutboxFailureDecision,
  computeOutboxDiagnostics,
} from '../domain/sync-compaction.policy';
import type {
  ClaimedOutboxEvent,
  OutboxDiagnosticSummary,
  OutboxMetricsRecorder,
  OutboxPublishInput,
  PublishOutboxInput,
} from '../types/sync.types';

export { evaluateOutboxFailureDecision, computeOutboxDiagnostics };
export type {
  OutboxMetricsRecorder,
  OutboxDiagnosticSummary,
  OutboxPublishInput,
  PublishOutboxInput,
  ClaimedOutboxEvent,
};

@Injectable()
export class OutboxRepository {
  private readonly logger = new Logger(OutboxRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx || this.prisma;
  }

  private normalizeUserId(userId?: string | null): string {
    const trimmed = (userId || '').trim();
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        trimmed,
      ) &&
      trimmed !== '00000000-0000-0000-0000-000000000000'
    ) {
      return trimmed;
    }
    throw new BadRequestException(
      `OutboxEvent requires a valid non-zero UUID userId, received: "${trimmed || 'empty'}"`,
    );
  }

  private resolveActorId(
    userId?: string | null,
    explicitActorId?: string | null,
  ): string | null {
    const candidate = (explicitActorId ?? userId ?? '').trim();
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        candidate,
      ) &&
      candidate !== '00000000-0000-0000-0000-000000000000'
    ) {
      return candidate;
    }
    return null;
  }

  async publishOutboxBatch(
    events: PublishOutboxInput[],
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (!events || events.length === 0) return [];
    const client = this.getClient(tx);

    const seenDedupeKeys = new Set<string>();
    const dedupedEvents: PublishOutboxInput[] = [];
    for (const ev of events) {
      if (ev.dedupeKey) {
        if (seenDedupeKeys.has(ev.dedupeKey)) continue;
        seenDedupeKeys.add(ev.dedupeKey);
      }
      dedupedEvents.push(ev);
    }

    const data: Prisma.OutboxEventCreateManyInput[] = dedupedEvents.map(
      (ev) => ({
        id: uuidv7(),
        userId: this.normalizeUserId(ev.userId),
        actorId: this.resolveActorId(ev.userId, ev.actorId),
        projectId: ev.projectId || null,
        aggregateId: ev.aggregateId,
        eventType: ev.eventType,
        payload: (ev.payload as Prisma.InputJsonValue) ?? {},
        dedupeKey: ev.dedupeKey ?? null,
        status: OutboxStatus.PENDING,
        retryCount: 0,
      }),
    );

    if (client.outboxEvent?.createMany) {
      await client.outboxEvent.createMany({
        data,
        skipDuplicates: true,
      });
      const candidateIds = data.map((d) => d.id!).filter(Boolean);
      if (typeof client.outboxEvent?.findMany === 'function') {
        const inserted = await client.outboxEvent.findMany({
          where: { id: { in: candidateIds } },
          select: { id: true },
        });
        return inserted.map((i) => i.id);
      }
      return candidateIds;
    }

    const createdIds: string[] = [];
    for (const row of data) {
      if (row.dedupeKey && client.outboxEvent?.upsert) {
        const upserted = await client.outboxEvent.upsert({
          where: { dedupeKey: row.dedupeKey },
          create: row,
          update: {},
        });
        createdIds.push(upserted.id);
      } else {
        const created = await client.outboxEvent.create({ data: row });
        createdIds.push(created.id);
      }
    }
    return createdIds;
  }

  async purgeProcessedOutboxEvents(
    publishedRetentionDays: number = 3,
    failedRetentionDays: number = 30,
    batchLimit: number = 1000,
  ): Promise<{ purgedPublished: number; purgedFailed: number }> {
    const publishedCutoff = new Date(
      Date.now() - publishedRetentionDays * 86400 * 1000,
    );
    const failedCutoff = new Date(
      Date.now() - failedRetentionDays * 86400 * 1000,
    );

    const [oldPublished, oldFailed] = await Promise.all([
      this.prisma.outboxEvent.findMany({
        where: {
          status: OutboxStatus.PUBLISHED,
          updatedAt: { lt: publishedCutoff },
        },
        select: { id: true },
        orderBy: { updatedAt: 'asc' },
        take: batchLimit,
      }),
      this.prisma.outboxEvent.findMany({
        where: {
          status: OutboxStatus.FAILED,
          updatedAt: { lt: failedCutoff },
        },
        select: { id: true },
        orderBy: { updatedAt: 'asc' },
        take: batchLimit,
      }),
    ]);

    const now = new Date();
    const [publishedDeleteRes, failedDeleteRes] = await Promise.all([
      oldPublished.length > 0
        ? this.prisma.outboxEvent.deleteMany({
            where: { id: { in: oldPublished.map((e) => e.id) } },
          })
        : Promise.resolve({ count: 0 }),
      oldFailed.length > 0
        ? this.prisma.outboxEvent.deleteMany({
            where: { id: { in: oldFailed.map((e) => e.id) } },
          })
        : Promise.resolve({ count: 0 }),
      this.prisma?.idempotencyRecord?.deleteMany
        ? this.prisma.idempotencyRecord.deleteMany({
            where: { expiresAt: { lt: now } },
          })
        : Promise.resolve(),
      this.prisma?.libraryInboxRecord?.deleteMany
        ? this.prisma.libraryInboxRecord.deleteMany({
            where: { expiresAt: { lt: now } },
          })
        : Promise.resolve(),
    ]);

    return {
      purgedPublished: publishedDeleteRes.count,
      purgedFailed: failedDeleteRes.count,
    };
  }

  async findById(id: string): Promise<OutboxEvent | null> {
    return this.prisma.outboxEvent.findUnique({
      where: { id },
    });
  }

  async claimSingleEvent(
    id: string,
    workerId: string,
    leaseMs: number = 60000,
    ignoreSchedule = false,
  ): Promise<boolean> {
    const now = new Date();
    const newLeaseExpiresAt = new Date(now.getTime() + leaseMs);

    // First try claiming a PENDING event without incrementing retryCount
    const pendingClaim = await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        status: OutboxStatus.PENDING,
        ...(ignoreSchedule
          ? {}
          : { OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] }),
      },
      data: {
        status: OutboxStatus.PROCESSING,
        claimedAt: now,
        leaseExpiresAt: newLeaseExpiresAt,
        claimedBy: workerId,
      },
    });
    if (pendingClaim.count > 0) return true;

    // Otherwise try reclaiming an expired PROCESSING lease and increment retryCount
    const expiredClaim = await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        status: OutboxStatus.PROCESSING,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: OutboxStatus.PROCESSING,
        claimedAt: now,
        leaseExpiresAt: newLeaseExpiresAt,
        claimedBy: workerId,
        retryCount: { increment: 1 },
      },
    });
    return expiredClaim.count > 0;
  }

  async markPublished(id: string, workerId?: string): Promise<boolean> {
    const res = await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        status: OutboxStatus.PROCESSING,
        ...(workerId ? { claimedBy: workerId } : {}),
      },
      data: {
        status: OutboxStatus.PUBLISHED,
        processedAt: new Date(),
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
        error: null,
      },
    });
    return res.count > 0;
  }

  async markDeadLetter(
    id: string,
    retryCount: number,
    errorMessage: string,
    workerId?: string,
  ): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        status: OutboxStatus.PROCESSING,
        ...(workerId ? { claimedBy: workerId } : {}),
      },
      data: {
        status: OutboxStatus.FAILED,
        retryCount,
        error: errorMessage,
        claimedAt: null,
        leaseExpiresAt: null,
        claimedBy: null,
      },
    });
  }

  async scheduleRetry(
    id: string,
    retryCount: number,
    scheduledAt: Date,
    errorMessage?: string,
    workerId?: string,
  ): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        status: OutboxStatus.PROCESSING,
        ...(workerId ? { claimedBy: workerId } : {}),
      },
      data: {
        status: OutboxStatus.PENDING,
        retryCount,
        scheduledAt,
        ...(errorMessage ? { error: errorMessage } : {}),
        claimedAt: null,
        leaseExpiresAt: null,
        claimedBy: null,
      },
    });
  }

  async claimBatch(
    batchSize: number = 50,
    leaseMs: number = 60000,
    workerId: string = 'outbox-worker',
  ): Promise<ClaimedOutboxEvent[]> {
    const now = new Date();
    const newLeaseExpiresAt = new Date(Date.now() + leaseMs);

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        userId: string;
        actorId: string | null;
        projectId: string | null;
        aggregateId: string;
        eventType: string;
        payload: Prisma.JsonValue;
        status: OutboxStatus;
        retryCount: number;
        error: string | null;
        scheduledAt: Date | string | null;
        claimedAt: Date | string | null;
        leaseExpiresAt: Date | string | null;
        claimedBy: string | null;
        dedupeKey: string | null;
        createdAt: Date | string;
        updatedAt: Date | string;
        processedAt: Date | string | null;
        previousStatus: OutboxStatus;
        previousLeaseExpiresAt: Date | string | null;
      }>
    >`
      WITH eligible AS (
        SELECT
          id,
          status,
          lease_expires_at,
          created_at,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(project_id, user_id)
            ORDER BY created_at ASC
          ) AS tenant_seq
        FROM outbox_events
        WHERE (
          (status = 'PENDING'::"OutboxStatus" AND (scheduled_at IS NULL OR scheduled_at <= ${now}))
          OR
          (status = 'PROCESSING'::"OutboxStatus" AND lease_expires_at <= ${now})
        )
      ),
      candidates AS (
        SELECT e.id, e.status, e.lease_expires_at
        FROM outbox_events e
        INNER JOIN eligible el ON el.id = e.id
        ORDER BY el.tenant_seq ASC, e.created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE OF e SKIP LOCKED
      )
      UPDATE outbox_events e
      SET status = 'PROCESSING'::"OutboxStatus",
          claimed_at = ${now},
          lease_expires_at = ${newLeaseExpiresAt},
          claimed_by = ${workerId},
          retry_count = e.retry_count + CASE WHEN c.status = 'PROCESSING'::"OutboxStatus" THEN 1 ELSE 0 END,
          updated_at = ${now}
      FROM candidates c
      WHERE e.id = c.id
      RETURNING 
        e.id,
        e.user_id AS "userId",
        e.actor_id AS "actorId",
        e.project_id AS "projectId",
        e.aggregate_id AS "aggregateId",
        e.event_type AS "eventType",
        e.payload,
        e.status,
        e.retry_count AS "retryCount",
        e.error,
        e.scheduled_at AS "scheduledAt",
        e.claimed_at AS "claimedAt",
        e.lease_expires_at AS "leaseExpiresAt",
        e.claimed_by AS "claimedBy",
        e.dedupe_key AS "dedupeKey",
        e.created_at AS "createdAt",
        e.updated_at AS "updatedAt",
        e.processed_at AS "processedAt",
        c.status AS "previousStatus",
        c.lease_expires_at AS "previousLeaseExpiresAt";
    `;

    if (!Array.isArray(rows) || rows.length === 0) {
      return [];
    }

    return rows.map((r) => ({
      event: {
        id: r.id,
        userId: r.userId,
        actorId: r.actorId ?? null,
        projectId: r.projectId,
        aggregateId: r.aggregateId,
        eventType: r.eventType,
        payload: r.payload,
        status: r.status,
        retryCount: r.retryCount,
        error: r.error,
        scheduledAt: r.scheduledAt ? new Date(r.scheduledAt) : null,
        claimedAt: r.claimedAt ? new Date(r.claimedAt) : null,
        leaseExpiresAt: r.leaseExpiresAt ? new Date(r.leaseExpiresAt) : null,
        claimedBy: r.claimedBy,
        dedupeKey: r.dedupeKey,
        createdAt: new Date(r.createdAt),
        updatedAt: new Date(r.updatedAt),
        processedAt: r.processedAt ? new Date(r.processedAt) : null,
      },
      isLeaseRecovery:
        r.previousStatus === OutboxStatus.PROCESSING &&
        r.previousLeaseExpiresAt !== null &&
        new Date(r.previousLeaseExpiresAt) <= now,
    }));
  }

  async renewLease(
    id: string,
    workerId: string,
    leaseMs: number = 60000,
  ): Promise<boolean> {
    const renewResult = await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        status: OutboxStatus.PROCESSING,
        claimedBy: workerId,
        leaseExpiresAt: { gt: new Date() },
      },
      data: {
        leaseExpiresAt: new Date(Date.now() + leaseMs),
      },
    });
    return renewResult.count > 0;
  }

  async getDiagnosticData(): Promise<{
    groupedPending: Array<{ eventType: string; count: number }>;
    oldestPendingCreatedAt: Date | null;
    processingCount: number;
  }> {
    const [grouped, oldest, processing] = await Promise.all([
      this.prisma.outboxEvent.groupBy({
        by: ['eventType'],
        where: { status: OutboxStatus.PENDING },
        _count: { _all: true },
      }),
      this.prisma.outboxEvent.findFirst({
        where: { status: OutboxStatus.PENDING },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.outboxEvent.count({
        where: { status: OutboxStatus.PROCESSING },
      }),
    ]);

    return {
      groupedPending: grouped.map((g) => ({
        eventType: g.eventType,
        count: g._count._all,
      })),
      oldestPendingCreatedAt: oldest?.createdAt ?? null,
      processingCount: processing,
    };
  }

  private splitInboxConsumerKey(rawKey: string): { consumer: string; eventId: string } {
    const idx = rawKey.indexOf(':');
    return idx <= 0 ? { consumer: 'default', eventId: rawKey } : { consumer: rawKey.slice(0, idx), eventId: rawKey.slice(idx + 1) };
  }

  async findInboxRecord(
    consumer: string,
    eventId: string,
  ): Promise<{ status: string; expiresAt: Date; [key: string]: unknown } | null> {
    if (typeof this.prisma?.libraryInboxRecord?.findUnique === 'function') {
      return this.prisma.libraryInboxRecord.findUnique({ where: { consumer_eventId: { consumer, eventId } } });
    }
    return this.findIdempotencyRecord(`${consumer}:${eventId}`);
  }

  async upsertInboxRecord(
    consumer: string,
    eventId: string,
    status: string,
    expiresAt: Date,
    ownerToken?: string,
  ): Promise<{ status: string; expiresAt: Date; [key: string]: unknown } | null> {
    if (typeof this.prisma?.libraryInboxRecord?.upsert === 'function') {
      const now = new Date();
      const fields = {
        status,
        ownerToken: ownerToken ?? null,
        leaseExpiresAt: status === 'processing' ? expiresAt : null,
        completedAt: status === 'completed' ? now : null,
        expiresAt,
      };
      return this.prisma.libraryInboxRecord.upsert({
        where: { consumer_eventId: { consumer, eventId } },
        create: { consumer, eventId, ...fields },
        update: fields,
      });
    }
    return this.upsertIdempotencyRecord(`${consumer}:${eventId}`, status, expiresAt);
  }

  async deleteInboxRecord(consumer: string, eventId: string, statuses?: string[]): Promise<void> {
    if (typeof this.prisma?.libraryInboxRecord?.deleteMany === 'function') {
      await this.prisma.libraryInboxRecord.deleteMany({
        where: { consumer, eventId, ...(statuses?.length ? { status: { in: statuses } } : {}) },
      });
      return;
    }
    await this.deleteIdempotencyRecords(`${consumer}:${eventId}`, statuses);
  }

  async findIdempotencyRecord(
    idempotencyKey: string,
    userId = 'system',
    projectId: string | null = null,
  ): Promise<{ status: string; expiresAt: Date; [key: string]: unknown } | null> {
    if (typeof this.prisma?.libraryInboxRecord?.findUnique === 'function' && userId === 'system' && !projectId) {
      const { consumer, eventId } = this.splitInboxConsumerKey(idempotencyKey);
      return this.prisma.libraryInboxRecord.findUnique({ where: { consumer_eventId: { consumer, eventId } } });
    }
    if (!this.prisma?.idempotencyRecord) return null;
    const scopeKey = projectId ? `proj:${projectId}` : `user:${userId}`;
    if (typeof this.prisma.idempotencyRecord.findUnique === 'function') {
      return this.prisma.idempotencyRecord.findUnique({ where: { scopeKey_idempotencyKey: { scopeKey, idempotencyKey } } });
    }
    if (typeof this.prisma.idempotencyRecord.findFirst === 'function') {
      return this.prisma.idempotencyRecord.findFirst({ where: { scopeKey, idempotencyKey } });
    }
    return null;
  }

  async upsertIdempotencyRecord(
    idempotencyKey: string,
    status: string,
    expiresAt: Date,
    userId = 'system',
    projectId: string | null = null,
  ): Promise<{ status: string; expiresAt: Date; [key: string]: unknown } | null> {
    if (typeof this.prisma?.libraryInboxRecord?.upsert === 'function' && userId === 'system' && !projectId) {
      const { consumer, eventId } = this.splitInboxConsumerKey(idempotencyKey);
      return this.upsertInboxRecord(consumer, eventId, status, expiresAt);
    }
    if (!this.prisma?.idempotencyRecord) return null;
    const scopeKey = projectId ? `proj:${projectId}` : `user:${userId}`;
    const safeUserId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)
      ? userId
      : '00000000-0000-0000-0000-000000000000';
    if (typeof this.prisma.idempotencyRecord.upsert === 'function') {
      return this.prisma.idempotencyRecord.upsert({
        where: { scopeKey_idempotencyKey: { scopeKey, idempotencyKey } },
        create: { scopeKey, userId: safeUserId, projectId: projectId || null, idempotencyKey, status, expiresAt },
        update: { status, expiresAt },
      });
    }
    return null;
  }

  async deleteIdempotencyRecords(
    idempotencyKey: string,
    statuses?: string[],
    userId = 'system',
    projectId: string | null = null,
  ): Promise<void> {
    if (typeof this.prisma?.libraryInboxRecord?.deleteMany === 'function' && userId === 'system' && !projectId) {
      const { consumer, eventId } = this.splitInboxConsumerKey(idempotencyKey);
      await this.deleteInboxRecord(consumer, eventId, statuses);
      return;
    }
    if (typeof this.prisma?.idempotencyRecord?.deleteMany !== 'function') return;
    const scopeKey = projectId ? `proj:${projectId}` : `user:${userId}`;
    await this.prisma.idempotencyRecord.deleteMany({
      where: { scopeKey, idempotencyKey, ...(statuses?.length ? { status: { in: statuses } } : {}) },
    });
  }

  async purgeExpiredIdempotencyRecords(now: Date = new Date()): Promise<number> {
    let count = 0;
    if (this.prisma?.libraryInboxRecord?.deleteMany) {
      count += (await this.prisma.libraryInboxRecord.deleteMany({ where: { expiresAt: { lt: now } } })).count;
    }
    if (this.prisma?.idempotencyRecord?.deleteMany) {
      count += (await this.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } })).count;
    }
    return count;
  }
}

async function transitionRetryOrDeadLetter(params: {
  event: { id: string; eventType: string; retryCount: number };
  maxRetries: number;
  workerId: string;
  repo: OutboxRepository;
  logger: Logger;
  metricsService?: OutboxMetricsRecorder;
  counterName: string;
  baseSec: number;
  maxSec: number;
  reasonMessage: string;
  retryLogFormatter: (newRetryCount: number, delaySec: number) => string;
  dlqLogFormatter: () => string;
}): Promise<'deadLettered' | 'retried'> {
  const { event, maxRetries, workerId, repo, logger, metricsService, counterName, baseSec, maxSec, reasonMessage, retryLogFormatter, dlqLogFormatter } = params;
  metricsService?.incrementCounter(counterName);
  const decision = evaluateOutboxFailureDecision(event.retryCount, maxRetries, baseSec, maxSec);
  if (decision.isDeadLetter) {
    logger.error(dlqLogFormatter());
    metricsService?.incrementCounter('outbox_dlq_total');
    await repo.markDeadLetter(event.id, decision.nextRetryCount, reasonMessage || 'Exceeded maximum retry attempts', workerId);
    return 'deadLettered';
  }
  logger.warn(retryLogFormatter(decision.nextRetryCount, decision.delaySec!));
  await repo.scheduleRetry(event.id, decision.nextRetryCount, decision.nextRetryAt!, reasonMessage, workerId);
  return 'retried';
}

export async function handleMissingOutboxHandler(params: {
  event: { id: string; eventType: string; retryCount: number };
  maxRetries: number;
  workerId: string;
  repo: OutboxRepository;
  logger: Logger;
  metricsService?: OutboxMetricsRecorder;
}): Promise<'deadLettered' | 'retried'> {
  const { event, maxRetries } = params;
  const reason = `No handler registered for event type "${event.eventType}"`;
  return transitionRetryOrDeadLetter({
    ...params,
    counterName: 'outbox_unhandled_event_total',
    baseSec: 10,
    maxSec: 600,
    reasonMessage: reason,
    retryLogFormatter: (attempt, delaySec) => `${reason} on event ${event.id}. Retrying in ${delaySec}s (attempt ${attempt}/${maxRetries})`,
    dlqLogFormatter: () => `Unrecognized event type "${event.eventType}" on event ${event.id} reached max retries (${maxRetries}). Moving to DLQ.`,
  });
}

export async function handleOutboxDispatchFailure(params: {
  event: { id: string; eventType: string; retryCount: number };
  err: unknown;
  maxRetries: number;
  workerId: string;
  repo: OutboxRepository;
  logger: Logger;
  metricsService?: OutboxMetricsRecorder;
}): Promise<'deadLettered' | 'retried'> {
  const { event, err, maxRetries } = params;
  const errMsg = err instanceof Error ? err.message : String(err);
  return transitionRetryOrDeadLetter({
    ...params,
    counterName: 'outbox_retry_total',
    baseSec: 1,
    maxSec: 300,
    reasonMessage: errMsg,
    retryLogFormatter: (attempt, delaySec) => `Event ${event.id} (${event.eventType}) failed (attempt ${attempt}/${maxRetries}). Retrying in ${delaySec}s: ${errMsg}`,
    dlqLogFormatter: () => `Event ${event.id} (${event.eventType}) reached max retries (${maxRetries}). Moving to FAILED / DLQ: ${errMsg}`,
  });
}

export async function executeOutboxGarbageCollection(params: {
  repo: OutboxRepository;
  changeLogRepo?: ChangeLogRepository;
  logger: Logger;
}): Promise<{ purgedPublished: number; purgedFailed: number; purgedChanges: number; purgedTombstones: number }> {
  const { repo, changeLogRepo, logger } = params;
  let purgedPublished = 0, purgedFailed = 0, purgedChanges = 0, purgedTombstones = 0;
  try {
    const now = new Date();
    const [outboxRes, , changeLogRes] = await Promise.all([
      repo.purgeProcessedOutboxEvents(3, 30, 1000),
      typeof repo.purgeExpiredIdempotencyRecords === 'function' ? repo.purgeExpiredIdempotencyRecords(now) : Promise.resolve(0),
      changeLogRepo ? changeLogRepo.compactAndPurgeChangeLog(30, 1000) : Promise.resolve(undefined),
    ]);
    purgedPublished = outboxRes.purgedPublished;
    purgedFailed = outboxRes.purgedFailed;
    if (changeLogRes) {
      purgedChanges = changeLogRes.purgedChanges;
      purgedTombstones = changeLogRes.purgedTombstones;
    }
    if (purgedPublished > 0 || purgedFailed > 0 || purgedChanges > 0 || purgedTombstones > 0) {
      logger.log(`[OutboxGC] Purged ${purgedPublished} published outbox events, ${purgedFailed} failed outbox events, ${purgedChanges} change log entries, and ${purgedTombstones} tombstones.`);
    }
  } catch (err: unknown) {
    logger.warn(`Outbox database GC sweep encountered error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { purgedPublished, purgedFailed, purgedChanges, purgedTombstones };
}

export async function buildOutboxDiagnosticSummary(params: {
  workerId: string;
  registeredHandlers: string[];
  hasHandler: (eventType: string) => boolean;
  hasDefaultHandler: boolean;
  repo: OutboxRepository;
  metricsService?: OutboxMetricsRecorder;
}): Promise<OutboxDiagnosticSummary> {
  const { workerId, registeredHandlers, hasHandler, hasDefaultHandler, repo, metricsService } = params;
  const { groupedPending, oldestPendingCreatedAt, processingCount } = await repo.getDiagnosticData();
  const summary = computeOutboxDiagnostics({ workerId, registeredHandlers, hasHandler, hasDefaultHandler, groupedPending, oldestPendingCreatedAt, processingCount });
  metricsService?.setGauge('outbox_pending_total', summary.totalPending);
  metricsService?.setGauge('outbox_processing_total', summary.totalProcessing);
  metricsService?.setGauge('outbox_oldest_pending_age_seconds', summary.oldestPendingAgeSeconds);
  return summary;
}
