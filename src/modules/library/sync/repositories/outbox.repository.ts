import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { OutboxStatus, OutboxEvent, Prisma } from '@prisma/client';

export interface ClaimedOutboxEvent {
  event: OutboxEvent;
  isLeaseRecovery: boolean;
}

export interface OutboxQueueMetrics {
  statusCounts: Record<string, number>;
  oldestPendingCreatedAt: Date | null;
  oldestPendingAgeMs: number;
  failedCount: number;
}

export interface DeadLetterEventsPage {
  items: OutboxEvent[];
  total: number;
}

@Injectable()
export class OutboxRepository {
  private readonly logger = new Logger(OutboxRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<OutboxEvent | null> {
    return this.prisma.outboxEvent.findUnique({
      where: { id },
    });
  }

  async claimSingleEvent(
    id: string,
    workerId: string,
    leaseMs: number = 60000,
  ): Promise<boolean> {
    const claimResult = await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        status: { in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
      },
      data: {
        status: OutboxStatus.PROCESSING,
        claimedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + leaseMs),
        claimedBy: workerId,
      },
    });
    return claimResult.count > 0;
  }

  async markMissingHandler(
    id: string,
    retryCount: number,
    isMax: boolean,
    eventType: string,
  ): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: { id, status: OutboxStatus.PROCESSING },
      data: {
        status: isMax ? OutboxStatus.FAILED : OutboxStatus.PENDING,
        retryCount,
        error: `No handler registered for event type "${eventType}"`,
        claimedAt: null,
        claimedBy: null,
      },
    });
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

  async markFailed(
    id: string,
    retryCount: number,
    isMax: boolean,
    errorMessage: string,
  ): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: { id, status: OutboxStatus.PROCESSING },
      data: {
        status: isMax ? OutboxStatus.FAILED : OutboxStatus.PENDING,
        retryCount,
        error: errorMessage,
        claimedAt: null,
        claimedBy: null,
      },
    });
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

    // 1. Production PostgreSQL path: Atomic batch claim with SKIP LOCKED
    if (typeof this.prisma.$queryRaw === 'function') {
      try {
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

        if (Array.isArray(rows) && rows.length > 0) {
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
              leaseExpiresAt: r.leaseExpiresAt
                ? new Date(r.leaseExpiresAt)
                : null,
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
        return [];
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `PostgreSQL SKIP LOCKED query raw unavailable or failed: ${message}. Falling back to optimistic findMany+updateMany.`,
        );
      }
    }

    // 2. Fallback: Optimistic locking
    return this.claimBatchOptimistic(batchSize, newLeaseExpiresAt, workerId);
  }

  private async claimBatchOptimistic(
    batchSize: number,
    newLeaseExpiresAt: Date,
    workerId: string,
  ): Promise<ClaimedOutboxEvent[]> {
    const now = new Date();
    const candidates = await this.prisma.outboxEvent.findMany({
      where: {
        OR: [
          {
            status: OutboxStatus.PENDING,
            OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
          },
          {
            status: OutboxStatus.PROCESSING,
            leaseExpiresAt: { lte: now },
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }],
      take: batchSize,
    });

    if (candidates.length === 0) return [];

    const claimed: ClaimedOutboxEvent[] = [];
    for (const candidate of candidates) {
      const claimResult = await this.prisma.outboxEvent.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          ...(candidate.status === OutboxStatus.PROCESSING
            ? { leaseExpiresAt: candidate.leaseExpiresAt }
            : {}),
        },
        data: {
          status: OutboxStatus.PROCESSING,
          claimedAt: now,
          leaseExpiresAt: newLeaseExpiresAt,
          claimedBy: workerId,
        },
      });

      if (claimResult.count > 0) {
        claimed.push({
          event: {
            ...candidate,
            status: OutboxStatus.PROCESSING,
            claimedAt: now,
            leaseExpiresAt: newLeaseExpiresAt,
            claimedBy: workerId,
          },
          isLeaseRecovery:
            candidate.status === OutboxStatus.PROCESSING &&
            candidate.leaseExpiresAt !== null &&
            candidate.leaseExpiresAt <= now,
        });
      }
    }
    return claimed;
  }

  async reclaimStalled(
    _batchSize: number = 50,
    _leaseMs: number = 60000,
    _workerId: string = 'outbox-worker',
  ): Promise<number> {
    const now = new Date();
    const result = await this.prisma.outboxEvent.updateMany({
      where: {
        status: OutboxStatus.PROCESSING,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: OutboxStatus.PENDING,
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
      },
    });
    return result.count;
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
    if (
      typeof this.prisma.outboxEvent.groupBy === 'function' &&
      typeof this.prisma.outboxEvent.findFirst === 'function'
    ) {
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

    const [pendingEvents, processingCount] = await Promise.all([
      this.prisma.outboxEvent.findMany({
        where: { status: OutboxStatus.PENDING },
        select: { eventType: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.outboxEvent.count({
        where: { status: OutboxStatus.PROCESSING },
      }),
    ]);

    const counts: Record<string, number> = {};
    for (const e of pendingEvents) {
      counts[e.eventType] = (counts[e.eventType] || 0) + 1;
    }

    return {
      groupedPending: Object.entries(counts).map(([eventType, count]) => ({
        eventType,
        count,
      })),
      oldestPendingCreatedAt: pendingEvents[0]?.createdAt ?? null,
      processingCount,
    };
  }

  async getQueueMetrics(): Promise<OutboxQueueMetrics> {
    if (
      typeof this.prisma.outboxEvent.groupBy === 'function' &&
      typeof this.prisma.outboxEvent.findFirst === 'function'
    ) {
      const [grouped, oldestPending, totalFailed] = await Promise.all([
        this.prisma.outboxEvent.groupBy({
          by: ['status'],
          _count: { id: true },
        }),
        this.prisma.outboxEvent.findFirst({
          where: { status: OutboxStatus.PENDING },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        this.prisma.outboxEvent.count({
          where: { status: OutboxStatus.FAILED },
        }),
      ]);

      const statusCounts: Record<string, number> = {};
      for (const g of grouped) {
        statusCounts[g.status] = g._count.id;
      }

      const oldestPendingCreatedAt = oldestPending?.createdAt ?? null;
      const oldestPendingAgeMs = oldestPendingCreatedAt
        ? Math.max(0, Date.now() - oldestPendingCreatedAt.getTime())
        : 0;

      return {
        statusCounts,
        oldestPendingCreatedAt,
        oldestPendingAgeMs,
        failedCount: totalFailed,
      };
    }

    return {
      statusCounts: {},
      oldestPendingCreatedAt: null,
      oldestPendingAgeMs: 0,
      failedCount: 0,
    };
  }

  async getDeadLetterEvents(
    options: { skip?: number; take?: number } = {},
  ): Promise<DeadLetterEventsPage> {
    const skip = options.skip ?? 0;
    const take = options.take ?? 50;

    const [items, total] = await Promise.all([
      this.prisma.outboxEvent.findMany({
        where: { status: OutboxStatus.FAILED },
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.outboxEvent.count({
        where: { status: OutboxStatus.FAILED },
      }),
    ]);

    return { items, total };
  }

  async retryFailedEvent(id: string): Promise<boolean> {
    const res = await this.prisma.outboxEvent.updateMany({
      where: { id, status: OutboxStatus.FAILED },
      data: {
        status: OutboxStatus.PENDING,
        retryCount: 0,
        error: null,
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
      },
    });
    return res.count > 0;
  }

  async retryAllDeadLetterEvents(limit: number = 100): Promise<number> {
    const failedEvents = await this.prisma.outboxEvent.findMany({
      where: { status: OutboxStatus.FAILED },
      select: { id: true },
      take: limit,
    });

    if (failedEvents.length === 0) return 0;

    const ids = failedEvents.map((e) => e.id);
    const res = await this.prisma.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: {
        status: OutboxStatus.PENDING,
        retryCount: 0,
        error: null,
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
      },
    });
    return res.count;
  }

  async cleanupPublished(retentionCutoff: Date): Promise<number> {
    const result = await this.prisma.outboxEvent.deleteMany({
      where: {
        status: OutboxStatus.PUBLISHED,
        processedAt: { lte: retentionCutoff },
      },
    });
    return result.count;
  }
}
