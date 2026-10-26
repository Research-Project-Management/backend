import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { OutboxStatus, OutboxEvent, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PublishOutboxInput } from '@/modules/library/core/ports/unit-of-work.port';

export type { PublishOutboxInput };

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

  async publishOutboxBatch(
    events: PublishOutboxInput[],
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (!events || events.length === 0) return [];
    const client = this.getClient(tx);

    const data: Prisma.OutboxEventCreateManyInput[] = events.map((ev) => ({
      id: randomUUID(),
      userId: ev.userId || '',
      projectId: ev.projectId || null,
      aggregateId: ev.aggregateId,
      eventType: ev.eventType,
      payload: (ev.payload as Prisma.InputJsonValue) ?? {},
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
  ): Promise<boolean> {
    const now = new Date();
    const claimResult = await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        OR: [
          {
            status: OutboxStatus.PENDING,
            OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
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
          claimed_by = ${workerId}
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
}
