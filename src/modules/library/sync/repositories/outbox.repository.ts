import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { OutboxStatus, OutboxEvent, Prisma } from '@prisma/client';
import { uuidv7, PublishOutboxInput as CorePublishOutboxInput } from '@/modules/library/core';
import {
  OutboxMetricsRecorder,
  OutboxDiagnosticSummary,
  evaluateOutboxFailureDecision,
  computeOutboxDiagnostics,
} from '../domain/outbox.domain';
import type { ChangeLogRepository } from './changelog.repository';

export interface OutboxPublishInput extends CorePublishOutboxInput {
  dedupeKey?: string | null;
}

export type PublishOutboxInput = OutboxPublishInput;

export interface ClaimedOutboxEvent {
  event: OutboxEvent;
  isLeaseRecovery: boolean;
}

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
      )
    ) {
      return trimmed;
    }
    return '00000000-0000-0000-0000-000000000000';
  }

  async publishOutboxBatch(
    events: PublishOutboxInput[],
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (!events || events.length === 0) return [];
    const client = this.getClient(tx);

    const data: Prisma.OutboxEventCreateManyInput[] = events.map((ev) => ({
      id: uuidv7(),
      userId: this.normalizeUserId(ev.userId),
      projectId: ev.projectId || null,
      aggregateId: ev.aggregateId,
      eventType: ev.eventType,
      payload: (ev.payload as Prisma.InputJsonValue) ?? {},
      dedupeKey: ev.dedupeKey ?? null,
      status: OutboxStatus.PENDING,
      retryCount: 0,
    }));

    if (client.outboxEvent?.createMany) {
      await client.outboxEvent.createMany({ data });
      return data.map((d) => d.id!);
    }

    const createdIds: string[] = [];
    for (const row of data) {
      const created = await client.outboxEvent.create({ data: row });
      createdIds.push(created.id);
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

  async findPending(batchSize: number = 50): Promise<OutboxEvent[]> {
    const claimed = await this.claimBatch(batchSize);
    return claimed.map((c) => c.event);
  }

  async claimSingleEvent(
    id: string,
    workerId: string,
    leaseMs: number = 60000,
    ignoreSchedule = false,
  ): Promise<boolean> {
    const now = new Date();
    const claimResult = await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        OR: [
          {
            status: OutboxStatus.PENDING,
            ...(ignoreSchedule
              ? {}
              : { OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] }),
          },
          { status: OutboxStatus.PROCESSING, leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: OutboxStatus.PROCESSING,
        claimedAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        claimedBy: workerId,
      },
    });
    return claimResult.count > 0;
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
      WITH candidates AS (
        SELECT id, status, lease_expires_at
        FROM outbox_events
        WHERE (
          (status = 'PENDING'::"OutboxStatus" AND (scheduled_at IS NULL OR scheduled_at <= ${now}))
          OR
          (status = 'PROCESSING'::"OutboxStatus" AND lease_expires_at <= ${now})
        )
        ORDER BY created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events e
      SET status = 'PROCESSING'::"OutboxStatus",
          claimed_at = ${now},
          lease_expires_at = ${newLeaseExpiresAt},
          claimed_by = ${workerId},
          updated_at = ${now}
      FROM candidates c
      WHERE e.id = c.id
      RETURNING 
        e.id,
        e.user_id AS "userId",
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

  async findIdempotencyRecord(idempotencyKey: string, userId = 'system') {
    if (!this.prisma?.idempotencyRecord?.findUnique) return null;
    const normalizedUserId = this.normalizeUserId(userId);
    return this.prisma.idempotencyRecord.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: normalizedUserId,
          idempotencyKey,
        },
      },
    });
  }

  async upsertIdempotencyRecord(
    idempotencyKey: string,
    status: string,
    expiresAt: Date,
    userId = 'system',
  ) {
    if (!this.prisma?.idempotencyRecord?.upsert) return null;
    const normalizedUserId = this.normalizeUserId(userId);
    return this.prisma.idempotencyRecord.upsert({
      where: {
        userId_idempotencyKey: {
          userId: normalizedUserId,
          idempotencyKey,
        },
      },
      create: {
        userId: normalizedUserId,
        idempotencyKey,
        status,
        expiresAt,
      },
      update: {
        status,
        expiresAt,
      },
    });
  }

  async deleteIdempotencyRecords(
    idempotencyKey: string,
    statuses?: string[],
    userId = 'system',
  ) {
    if (!this.prisma?.idempotencyRecord?.deleteMany) return;
    const normalizedUserId = this.normalizeUserId(userId);
    await this.prisma.idempotencyRecord.deleteMany({
      where: {
        userId: normalizedUserId,
        idempotencyKey,
        ...(statuses && statuses.length > 0
          ? { status: { in: statuses } }
          : {}),
      },
    });
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
  const {
    event, maxRetries, workerId, repo, logger, metricsService,
    counterName, baseSec, maxSec, reasonMessage, retryLogFormatter, dlqLogFormatter,
  } = params;
  metricsService?.incrementCounter(counterName);
  const decision = evaluateOutboxFailureDecision(event.retryCount, maxRetries, baseSec, maxSec);

  if (decision.isDeadLetter) {
    logger.error(dlqLogFormatter());
    metricsService?.incrementCounter('outbox_dlq_total');
    await repo.markDeadLetter(
      event.id,
      decision.nextRetryCount,
      reasonMessage || 'Exceeded maximum retry attempts',
      workerId,
    );
    return 'deadLettered';
  }

  logger.warn(retryLogFormatter(decision.nextRetryCount, decision.delaySec!));
  await repo.scheduleRetry(
    event.id,
    decision.nextRetryCount,
    decision.nextRetryAt!,
    reasonMessage,
    workerId,
  );
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
    retryLogFormatter: (attempt, delaySec) =>
      `${reason} on event ${event.id}. Retrying in ${delaySec}s (attempt ${attempt}/${maxRetries})`,
    dlqLogFormatter: () =>
      `Unrecognized event type "${event.eventType}" on event ${event.id} reached max retries (${maxRetries}). Moving to DLQ.`,
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
    retryLogFormatter: (attempt, delaySec) =>
      `Event ${event.id} (${event.eventType}) failed (attempt ${attempt}/${maxRetries}). Retrying in ${delaySec}s: ${errMsg}`,
    dlqLogFormatter: () =>
      `Event ${event.id} (${event.eventType}) reached max retries (${maxRetries}). Moving to FAILED / DLQ: ${errMsg}`,
  });
}

export async function executeOutboxGarbageCollection(params: {
  repo: OutboxRepository;
  changeLogRepo?: ChangeLogRepository;
  logger: Logger;
}): Promise<{
  purgedPublished: number;
  purgedFailed: number;
  purgedChanges: number;
  purgedTombstones: number;
}> {
  const { repo, changeLogRepo, logger } = params;
  let purgedPublished = 0;
  let purgedFailed = 0;
  let purgedChanges = 0;
  let purgedTombstones = 0;

  try {
    const outboxRes = await repo.purgeProcessedOutboxEvents(3, 30, 1000);
    purgedPublished = outboxRes.purgedPublished;
    purgedFailed = outboxRes.purgedFailed;

    if (changeLogRepo) {
      const changeLogRes = await changeLogRepo.compactAndPurgeChangeLog(30, 1000);
      purgedChanges = changeLogRes.purgedChanges;
      purgedTombstones = changeLogRes.purgedTombstones;
    }
    if (purgedPublished > 0 || purgedFailed > 0 || purgedChanges > 0 || purgedTombstones > 0) {
      logger.log(
        `[OutboxGC] Purged ${purgedPublished} published outbox events, ${purgedFailed} failed outbox events, ${purgedChanges} change log entries, and ${purgedTombstones} tombstones.`,
      );
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`Outbox database GC sweep encountered error: ${errMsg}`);
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
  const summary = computeOutboxDiagnostics({
    workerId,
    registeredHandlers,
    hasHandler,
    hasDefaultHandler,
    groupedPending,
    oldestPendingCreatedAt,
    processingCount,
  });

  metricsService?.setGauge('outbox_pending_total', summary.totalPending);
  metricsService?.setGauge('outbox_processing_total', summary.totalProcessing);
  metricsService?.setGauge('outbox_oldest_pending_age_seconds', summary.oldestPendingAgeSeconds);

  return summary;
}

export const OutboxEventHandlers = {
  handleMissingOutboxHandler,
  handleOutboxDispatchFailure,
  executeOutboxGarbageCollection,
  buildOutboxDiagnosticSummary,
};
