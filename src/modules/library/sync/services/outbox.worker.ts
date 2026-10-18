import {
  Injectable,
  Logger,
  Optional,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '@/core';
import { OutboxMetrics } from './outbox.metrics';
import { OutboxStatus, OutboxEvent, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  LIBRARY_OUTBOX_QUEUE,
  LIBRARY_OUTBOX_JOB,
} from '@/modules/library/sync/types/outbox.constants';

import { OutboxDispatchHandler } from '@/modules/library/core';
export type { OutboxDispatchHandler };

@Injectable()
export class OutboxWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxWorker.name);
  private readonly handlers = new Map<string, OutboxDispatchHandler>();
  private defaultHandler?: OutboxDispatchHandler;
  private readonly maxRetries = 5;
  private readonly workerId: string;

  private pollTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isShuttingDown = false;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly metricsService?: OutboxMetrics,
    @Optional()
    @InjectQueue(LIBRARY_OUTBOX_QUEUE)
    private readonly bullQueue?: Queue,
  ) {
    this.workerId = `outbox-worker-${process.pid}-${randomUUID().slice(0, 8)}`;
    if (typeof this.bullQueue?.on === 'function') {
      this.bullQueue.on('error', (err: Error) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Outbox BullMQ queue notice: ${message}`);
      });
    }
  }

  getWorkerId(): string {
    return this.workerId;
  }

  registerHandler(eventType: string, handler: OutboxDispatchHandler) {
    this.handlers.set(eventType, handler);
    this.logger.log(`Registered Outbox dispatch handler for: ${eventType}`);
  }

  registerDefaultHandler(handler: OutboxDispatchHandler) {
    this.defaultHandler = handler;
    this.logger.log('Registered default fallback Outbox dispatch handler');
  }

  hasHandler(eventType: string): boolean {
    return this.handlers.has(eventType);
  }

  /**
   * Immediately dispatches or enqueues newly written outbox events.
   * Triggered upon PostgreSQL transaction commit from TransactionService.
   */
  async notifyEvents(eventIds: string[]): Promise<void> {
    if (!eventIds || eventIds.length === 0) return;

    const jobOpts = {
      attempts: this.maxRetries,
      backoff: { type: 'exponential' as const, delay: 1000 },
      removeOnComplete: true,
    };

    if (this.bullQueue && typeof this.bullQueue.addBulk === 'function') {
      await this.bullQueue
        .addBulk(
          eventIds.map((eventId) => ({
            name: LIBRARY_OUTBOX_JOB,
            data: { eventId },
            opts: jobOpts,
          })),
        )
        .catch((err) => {
          this.logger.warn(
            `Failed to bulk-enqueue ${eventIds.length} outbox event(s) to BullMQ: ${err?.message}. Falling back to direct dispatch.`,
          );
          for (const eventId of eventIds) {
            void this.processEventById(eventId);
          }
        });
    } else if (this.bullQueue && typeof this.bullQueue.add === 'function') {
      for (const eventId of eventIds) {
        await this.bullQueue
          .add(LIBRARY_OUTBOX_JOB, { eventId }, jobOpts)
          .catch((err) => {
            this.logger.warn(
              `Failed to enqueue outbox event ${eventId} to BullMQ: ${err?.message}. Falling back to direct dispatch.`,
            );
            void this.processEventById(eventId);
          });
      }
    } else {
      // In-memory or test environment fallback
      for (const eventId of eventIds) {
        void this.processEventById(eventId);
      }
    }
  }

  /**
   * Processes a single OutboxEvent by ID with atomic CAS claiming.
   * Idempotent: safe to run from BullMQ or in-memory runner.
   */
  async processEventById(eventId: string): Promise<boolean> {
    const event = await this.prisma.outboxEvent.findUnique({
      where: { id: eventId },
    });

    if (!event || event.status === OutboxStatus.PUBLISHED) {
      return true;
    }

    // Atomic CAS claim: only move if PENDING or FAILED
    const leaseMs =
      Number(
        this.configService?.get('OUTBOX_LEASE_MS') ||
          process.env.OUTBOX_LEASE_MS,
      ) || 60000;
    const claimResult = await this.prisma.outboxEvent.updateMany({
      where: {
        id: eventId,
        status: { in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
      },
      data: {
        status: OutboxStatus.PROCESSING,
        claimedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + leaseMs),
        claimedBy: this.workerId,
      },
    });

    if (claimResult.count === 0) {
      return true;
    }

    const handler = this.handlers.get(event.eventType) || this.defaultHandler;
    if (!handler) {
      const newRetryCount = event.retryCount + 1;
      const isMax = newRetryCount >= this.maxRetries;
      await this.prisma.outboxEvent.updateMany({
        where: { id: eventId, status: OutboxStatus.PROCESSING },
        data: {
          status: isMax ? OutboxStatus.FAILED : OutboxStatus.PENDING,
          retryCount: newRetryCount,
          error: `No handler registered for event type "${event.eventType}"`,
          claimedAt: null,
          claimedBy: null,
        },
      });
      return false;
    }

    const start = performance.now();
    try {
      await handler.handle(event);
      const durationMs = Math.round(performance.now() - start);

      await this.prisma.outboxEvent.updateMany({
        where: { id: eventId, status: OutboxStatus.PROCESSING },
        data: {
          status: OutboxStatus.PUBLISHED,
          processedAt: new Date(),
          claimedAt: null,
          claimedBy: null,
          error: null,
        },
      });

      this.metricsService?.recordOutboxDispatch(durationMs, true);
      this.metricsService?.incrementCounter('outbox_dispatched_total');
      return true;
    } catch (err: unknown) {
      const durationMs = Math.round(performance.now() - start);
      const newRetryCount = event.retryCount + 1;
      const isMax = newRetryCount >= this.maxRetries;
      const errMsg = err instanceof Error ? err.message : String(err);

      this.logger.error(
        `[OutboxWorker] Event ${eventId} (${event.eventType}) failed (attempt ${newRetryCount}/${this.maxRetries}): ${errMsg}`,
      );

      await this.prisma.outboxEvent.updateMany({
        where: { id: eventId, status: OutboxStatus.PROCESSING },
        data: {
          status: isMax ? OutboxStatus.FAILED : OutboxStatus.PENDING,
          retryCount: newRetryCount,
          error: errMsg,
          claimedAt: null,
          claimedBy: null,
        },
      });

      this.metricsService?.recordOutboxDispatch(durationMs, false);
      this.metricsService?.incrementCounter('outbox_retry_total');
      if (isMax) {
        this.metricsService?.incrementCounter('outbox_dlq_total');
      }
      throw err;
    }
  }

  onApplicationBootstrap() {
    const isTestEnv = process.env.NODE_ENV === 'test';
    const configEnabled = this.configService?.get<string>(
      'OUTBOX_WORKER_ENABLED',
    );
    const envEnabled = process.env.OUTBOX_WORKER_ENABLED;

    // Do not run background polling loop in test environment unless explicitly enabled
    const isEnabled =
      configEnabled !== undefined
        ? configEnabled === 'true'
        : envEnabled !== undefined
          ? envEnabled === 'true'
          : !isTestEnv;

    if (isEnabled) {
      const intervalMs =
        Number(
          this.configService?.get('OUTBOX_POLL_INTERVAL_MS') ||
            process.env.OUTBOX_POLL_INTERVAL_MS,
        ) || (this.bullQueue ? 60000 : 10000);

      this.logger.log(
        `Starting runtime Outbox consumer [${this.workerId}] (interval=${intervalMs}ms)...`,
      );
      void this.logStartupDiagnostics();
      this.startPolling(intervalMs);
    } else {
      this.logger.log(
        `Outbox consumer runner is disabled (NODE_ENV=${process.env.NODE_ENV || 'development'}).`,
      );
    }
  }

  async logStartupDiagnostics(): Promise<void> {
    try {
      const diag = await this.getDiagnosticSummary();
      this.logger.log(
        `[OutboxDiagnostics] workerId=${diag.workerId} registeredHandlers=[${diag.registeredHandlers.join(
          ', ',
        )}] totalPending=${diag.totalPending} totalProcessing=${diag.totalProcessing} oldestPendingAgeSec=${diag.oldestPendingAgeSeconds}`,
      );
      if (diag.unhandledEventTypes.length > 0) {
        this.logger.warn(
          `[OutboxDiagnostics] Found pending events without registered handlers: ${diag.unhandledEventTypes.join(
            ', ',
          )}`,
        );
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to collect startup outbox diagnostics: ${errMsg}`,
      );
    }
  }

  /**
   * Diagnostic summary of registered handlers, pending queue depths, and oldest pending item age.
   */
  async getDiagnosticSummary(): Promise<{
    workerId: string;
    registeredHandlers: string[];
    pendingCountsByType: Record<string, number>;
    totalPending: number;
    totalProcessing: number;
    oldestPendingAgeSeconds: number;
    unhandledEventTypes: string[];
  }> {
    const now = new Date();
    const pendingCountsByType: Record<string, number> = {};
    let totalPending = 0;
    let oldestPendingAgeSeconds = 0;
    const unhandledSet = new Set<string>();

    if (
      typeof this.prisma.outboxEvent.groupBy === 'function' &&
      typeof this.prisma.outboxEvent.findFirst === 'function'
    ) {
      const [groupedPending, oldestPending, processingCount] =
        await Promise.all([
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

      if (oldestPending?.createdAt) {
        oldestPendingAgeSeconds = Math.max(
          0,
          Math.floor(
            (now.getTime() - oldestPending.createdAt.getTime()) / 1000,
          ),
        );
      }

      for (const group of groupedPending) {
        const count = group._count._all;
        pendingCountsByType[group.eventType] = count;
        totalPending += count;
        if (!this.handlers.has(group.eventType)) {
          unhandledSet.add(group.eventType);
        }
      }

      this.metricsService?.setGauge('outbox_pending_total', totalPending);
      this.metricsService?.setGauge('outbox_processing_total', processingCount);
      this.metricsService?.setGauge(
        'outbox_oldest_pending_age_seconds',
        oldestPendingAgeSeconds,
      );

      return {
        workerId: this.workerId,
        registeredHandlers: Array.from(this.handlers.keys()),
        pendingCountsByType,
        totalPending,
        totalProcessing: processingCount,
        oldestPendingAgeSeconds,
        unhandledEventTypes: Array.from(unhandledSet),
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

    totalPending = pendingEvents.length;
    if (pendingEvents.length > 0) {
      const oldest = pendingEvents[0].createdAt;
      oldestPendingAgeSeconds = Math.max(
        0,
        Math.floor((now.getTime() - oldest.getTime()) / 1000),
      );
    }

    for (const evt of pendingEvents) {
      pendingCountsByType[evt.eventType] =
        (pendingCountsByType[evt.eventType] || 0) + 1;
      if (!this.handlers.has(evt.eventType)) {
        unhandledSet.add(evt.eventType);
      }
    }

    this.metricsService?.setGauge('outbox_pending_total', totalPending);
    this.metricsService?.setGauge('outbox_processing_total', processingCount);
    this.metricsService?.setGauge(
      'outbox_oldest_pending_age_seconds',
      oldestPendingAgeSeconds,
    );

    return {
      workerId: this.workerId,
      registeredHandlers: Array.from(this.handlers.keys()),
      pendingCountsByType,
      totalPending,
      totalProcessing: processingCount,
      oldestPendingAgeSeconds,
      unhandledEventTypes: Array.from(unhandledSet),
    };
  }

  startPolling(intervalMs: number) {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      void this.runPollCycle();
    }, intervalMs);
    this.pollTimer.unref();

    // Initial immediate cycle
    void this.runPollCycle();
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async runPollCycle(): Promise<void> {
    if (this.isProcessing || this.isShuttingDown) {
      return;
    }

    this.isProcessing = true;
    const start = performance.now();

    try {
      const batchSize =
        Number(
          this.configService?.get('OUTBOX_BATCH_SIZE') ||
            process.env.OUTBOX_BATCH_SIZE,
        ) || 50;
      const leaseMs =
        Number(
          this.configService?.get('OUTBOX_LEASE_MS') ||
            process.env.OUTBOX_LEASE_MS,
        ) || 60000;

      const result = await this.processPendingEvents(batchSize, leaseMs);
      const durationMs = Math.round(performance.now() - start);

      if (
        result.processed > 0 ||
        result.failed > 0 ||
        result.deadLettered > 0
      ) {
        this.logger.log(
          `[OutboxCycle] processed=${result.processed} failed=${result.failed} deadLettered=${result.deadLettered} reclaimed=${result.reclaimed} (${durationMs}ms)`,
        );
      }

      this.metricsService?.recordOutboxDispatch(durationMs, true);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[OutboxCycle] Worker cycle encountered error: ${errMsg}`,
      );
      this.metricsService?.recordOutboxDispatch(
        Math.round(performance.now() - start),
        false,
      );
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Claims up to `batchSize` pending or expired-lease outbox events atomically.
   * In PostgreSQL (production/integration), uses `SELECT ... FOR UPDATE SKIP LOCKED`
   * with `UPDATE ... FROM ... RETURNING` in a single round-trip.
   * If `$queryRaw` is not available (such as in unit tests mocking `outboxEvent`),
   * falls back to the optimistic `findMany` + `updateMany` loop.
   */
  async claimBatch(
    batchSize: number = 50,
    leaseMs: number = 60000,
  ): Promise<Array<{ event: OutboxEvent; isLeaseRecovery: boolean }>> {
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
              claimed_by = ${this.workerId}
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
          `Atomic raw claim skipped or unavailable (${message}); falling back to ORM optimistic claim`,
        );
      }
    }

    // 2. Fallback path (unit test mocks without $queryRaw or non-PG env)
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

    const claimedList: Array<{ event: OutboxEvent; isLeaseRecovery: boolean }> =
      [];

    for (const event of candidates) {
      const isLeaseRecovery =
        event.status === OutboxStatus.PROCESSING &&
        event.leaseExpiresAt !== null &&
        event.leaseExpiresAt <= now;

      const claimResult = await this.prisma.outboxEvent.updateMany({
        where: {
          id: event.id,
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
        data: {
          status: OutboxStatus.PROCESSING,
          claimedAt: now,
          leaseExpiresAt: newLeaseExpiresAt,
          claimedBy: this.workerId,
        },
      });

      if (claimResult.count > 0) {
        claimedList.push({ event, isLeaseRecovery });
      }
    }

    return claimedList;
  }

  /**
   * Processes pending events and recovers expired processing leases with strict atomic claiming and CAS heartbeat.
   */
  async processPendingEvents(
    batchSize: number = 50,
    leaseMs: number = 60000,
  ): Promise<{
    processed: number;
    failed: number;
    deadLettered: number;
    reclaimed: number;
  }> {
    const claimedItems = await this.claimBatch(batchSize, leaseMs);

    let processed = 0;
    let failed = 0;
    let deadLettered = 0;
    let reclaimed = 0;

    for (const { event, isLeaseRecovery } of claimedItems) {
      if (isLeaseRecovery) {
        reclaimed++;
        this.metricsService?.incrementCounter('outbox_lease_reclaimed_total');
        this.logger.warn(
          `Reclaimed expired PROCESSING event ${event.id} (type: ${event.eventType}, previousWorker: ${event.claimedBy || 'unknown'})`,
        );
      }

      // 3. Unhandled event policy: Check registered handlers first, then default fallback handler
      const handler = this.handlers.get(event.eventType) || this.defaultHandler;
      if (!handler) {
        const newRetryCount = event.retryCount + 1;
        this.metricsService?.incrementCounter('outbox_unhandled_event_total');

        if (newRetryCount >= this.maxRetries) {
          this.logger.error(
            `Unrecognized event type "${event.eventType}" on event ${event.id} reached max retries (${this.maxRetries}). Moving to DLQ.`,
          );
          this.metricsService?.incrementCounter('outbox_dlq_total');
          await this.prisma.outboxEvent.updateMany({
            where: {
              id: event.id,
              status: OutboxStatus.PROCESSING,
              claimedBy: this.workerId,
            },
            data: {
              status: OutboxStatus.FAILED,
              retryCount: newRetryCount,
              error: `No handler registered for event type "${event.eventType}"`,
              claimedAt: null,
              leaseExpiresAt: null,
              claimedBy: null,
            },
          });
          deadLettered++;
        } else {
          const delaySec = Math.pow(2, newRetryCount) * 10;
          this.logger.warn(
            `No handler registered for event type "${event.eventType}" on event ${event.id}. Retrying in ${delaySec}s (attempt ${newRetryCount}/${this.maxRetries})`,
          );
          await this.prisma.outboxEvent.updateMany({
            where: {
              id: event.id,
              status: OutboxStatus.PROCESSING,
              claimedBy: this.workerId,
            },
            data: {
              status: OutboxStatus.PENDING,
              retryCount: newRetryCount,
              scheduledAt: new Date(Date.now() + delaySec * 1000),
              claimedAt: null,
              leaseExpiresAt: null,
              claimedBy: null,
            },
          });
        }
        continue;
      }

      // 4. Start Heartbeat Lease Renewal Loop with AbortController for cooperative cancellation
      const abortController = new AbortController();
      let isLeaseLost = false;
      const heartbeatIntervalMs = Math.max(1000, Math.floor(leaseMs / 3));
      const heartbeatTimer = setInterval(() => {
        void (async () => {
          try {
            const renewResult = await this.prisma.outboxEvent.updateMany({
              where: {
                id: event.id,
                status: OutboxStatus.PROCESSING,
                claimedBy: this.workerId,
                leaseExpiresAt: { gt: new Date() },
              },
              data: {
                leaseExpiresAt: new Date(Date.now() + leaseMs),
              },
            });

            if (renewResult.count === 0) {
              isLeaseLost = true;
              abortController.abort();
              this.logger.error(
                `Worker [${this.workerId}] LOST LEASE on OutboxEvent ${event.id}. Aborting handler execution.`,
              );
              this.metricsService?.incrementCounter('outbox_lease_lost_total');
              clearInterval(heartbeatTimer);
            }
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Heartbeat renewal failed for event ${event.id}: ${errMsg}`,
            );
          }
        })();
      }, heartbeatIntervalMs);
      heartbeatTimer.unref();

      // 5. Execute registered handler
      try {
        await handler.handle(event, abortController.signal);
        clearInterval(heartbeatTimer);

        if (isLeaseLost) {
          this.logger.error(
            `Worker [${this.workerId}] refused to publish event ${event.id} due to lost lease.`,
          );
          continue;
        }

        // Success: Atomic final transition confirming claimedBy matches
        const pubResult = await this.prisma.outboxEvent.updateMany({
          where: {
            id: event.id,
            status: OutboxStatus.PROCESSING,
            claimedBy: this.workerId,
          },
          data: {
            status: OutboxStatus.PUBLISHED,
            processedAt: new Date(),
            claimedAt: null,
            leaseExpiresAt: null,
            claimedBy: null,
            error: null,
          },
        });

        if (pubResult.count === 0) {
          this.logger.warn(
            `Worker [${this.workerId}] lost claim before publishing event ${event.id}.`,
          );
          this.metricsService?.incrementCounter('outbox_lease_lost_total');
        } else {
          processed++;
        }
      } catch (err: unknown) {
        clearInterval(heartbeatTimer);

        if (isLeaseLost) {
          this.logger.error(
            `Worker [${this.workerId}] aborted error handling for event ${event.id} due to lost lease.`,
          );
          continue;
        }

        const newRetryCount = event.retryCount + 1;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.metricsService?.incrementCounter('outbox_retry_total');

        if (newRetryCount >= this.maxRetries) {
          this.logger.error(
            `Event ${event.id} (${event.eventType}) reached max retries (${this.maxRetries}). Moving to FAILED / DLQ: ${errMsg}`,
          );
          this.metricsService?.incrementCounter('outbox_dlq_total');

          await this.prisma.outboxEvent.updateMany({
            where: {
              id: event.id,
              status: OutboxStatus.PROCESSING,
              claimedBy: this.workerId,
            },
            data: {
              status: OutboxStatus.FAILED,
              retryCount: newRetryCount,
              error: errMsg || 'Exceeded maximum retry attempts',
              claimedAt: null,
              leaseExpiresAt: null,
              claimedBy: null,
            },
          });
          deadLettered++;
        } else {
          const delaySec = Math.pow(2, newRetryCount);
          const nextSchedule = new Date(Date.now() + delaySec * 1000);

          this.logger.warn(
            `Event ${event.id} (${event.eventType}) failed (attempt ${newRetryCount}/${this.maxRetries}). Retrying in ${delaySec}s: ${errMsg}`,
          );

          await this.prisma.outboxEvent.updateMany({
            where: {
              id: event.id,
              status: OutboxStatus.PROCESSING,
              claimedBy: this.workerId,
            },
            data: {
              status: OutboxStatus.PENDING,
              retryCount: newRetryCount,
              error: errMsg,
              scheduledAt: nextSchedule,
              claimedAt: null,
              leaseExpiresAt: null,
              claimedBy: null,
            },
          });
          failed++;
        }
      }
    }

    return { processed, failed, deadLettered, reclaimed };
  }

  /**
   * Purges completed outbox events older than `olderThanMs` (default 7 days).
   * Prevents table bloat and maintains high-throughput B-tree index performance.
   */
  async purgeCompletedEvents(
    olderThanMs: number = 7 * 24 * 60 * 60 * 1000,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.prisma.outboxEvent.deleteMany({
      where: {
        status: OutboxStatus.PUBLISHED,
        processedAt: { lte: cutoff },
      },
    });
    if (result.count > 0) {
      this.logger.log(
        `Purged ${result.count} completed outbox events older than ${cutoff.toISOString()}`,
      );
    }
    return result.count;
  }

  onApplicationShutdown() {
    this.isShuttingDown = true;
    this.stopPolling();
    this.logger.log(`Outbox consumer [${this.workerId}] shut down gracefully.`);
  }
}
