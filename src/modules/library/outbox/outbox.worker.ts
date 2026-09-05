import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../core/database/prisma.service';
import { OutboxMetrics as SyncMetricsService } from './outbox.metrics';
import { OutboxStatus, OutboxEvent } from '@prisma/client';
import { randomUUID } from 'crypto';

export interface OutboxDispatchHandler {
  handle(event: OutboxEvent, signal?: AbortSignal): Promise<void>;
}

@Injectable()
export class OutboxWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxWorker.name);
  private readonly handlers = new Map<string, OutboxDispatchHandler>();
  private readonly maxRetries = 5;
  private readonly workerId: string;

  private pollTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isShuttingDown = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService?: ConfigService,
    private readonly metricsService?: SyncMetricsService,
  ) {
    this.workerId = `outbox-worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  getWorkerId(): string {
    return this.workerId;
  }

  registerHandler(eventType: string, handler: OutboxDispatchHandler) {
    this.handlers.set(eventType, handler);
    this.logger.log(`Registered Outbox dispatch handler for: ${eventType}`);
  }

  hasHandler(eventType: string): boolean {
    return this.handlers.has(eventType);
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
        ) || 5000;

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
    } catch (err: any) {
      this.logger.warn(
        `Failed to collect startup outbox diagnostics: ${err.message}`,
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

    const pendingCountsByType: Record<string, number> = {};
    let oldestPendingAgeSeconds = 0;

    if (pendingEvents.length > 0) {
      const oldest = pendingEvents[0].createdAt;
      oldestPendingAgeSeconds = Math.max(
        0,
        Math.floor((now.getTime() - oldest.getTime()) / 1000),
      );
    }

    const unhandledSet = new Set<string>();
    for (const evt of pendingEvents) {
      pendingCountsByType[evt.eventType] =
        (pendingCountsByType[evt.eventType] || 0) + 1;
      if (!this.handlers.has(evt.eventType)) {
        unhandledSet.add(evt.eventType);
      }
    }

    this.metricsService?.setGauge('outbox_pending_total', pendingEvents.length);
    this.metricsService?.setGauge('outbox_processing_total', processingCount);
    this.metricsService?.setGauge(
      'outbox_oldest_pending_age_seconds',
      oldestPendingAgeSeconds,
    );

    return {
      workerId: this.workerId,
      registeredHandlers: Array.from(this.handlers.keys()),
      pendingCountsByType,
      totalPending: pendingEvents.length,
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
    } catch (err: any) {
      this.logger.error(
        `[OutboxCycle] Worker cycle encountered error: ${err.message}`,
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
    const now = new Date();

    // 1. Query candidate events: PENDING scheduled for now OR PROCESSING with expired lease
    const candidates = await this.prisma.outboxEvent.findMany({
      where: {
        OR: [
          {
            status: OutboxStatus.PENDING,
            OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
          },
          {
            status: OutboxStatus.PROCESSING,
            leaseExpiresAt: { lte: now }, // Expired lease recovery
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }],
      take: batchSize,
    });

    let processed = 0;
    let failed = 0;
    let deadLettered = 0;
    let reclaimed = 0;

    for (const event of candidates) {
      const isLeaseRecovery =
        event.status === OutboxStatus.PROCESSING &&
        event.leaseExpiresAt !== null &&
        event.leaseExpiresAt <= now;

      const newLeaseExpiresAt = new Date(Date.now() + leaseMs);

      // 2. Atomic optimistic claim & lease acquisition
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

      if (claimResult.count === 0) {
        // Lost claim race to another worker instance or lease was renewed
        continue;
      }

      if (isLeaseRecovery) {
        reclaimed++;
        this.metricsService?.incrementCounter('outbox_lease_reclaimed_total');
        this.logger.warn(
          `Reclaimed expired PROCESSING event ${event.id} (type: ${event.eventType}, previousWorker: ${event.claimedBy || 'unknown'})`,
        );
      }

      // 3. Unhandled event policy: Finite backoff retry and DLQ transition
      const handler = this.handlers.get(event.eventType);
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
          } catch (err: any) {
            this.logger.warn(
              `Heartbeat renewal failed for event ${event.id}: ${err.message}`,
            );
          }
        })();
      }, heartbeatIntervalMs);

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
      } catch (err: any) {
        clearInterval(heartbeatTimer);

        if (isLeaseLost) {
          this.logger.error(
            `Worker [${this.workerId}] aborted error handling for event ${event.id} due to lost lease.`,
          );
          continue;
        }

        const newRetryCount = event.retryCount + 1;
        this.metricsService?.incrementCounter('outbox_retry_total');

        if (newRetryCount >= this.maxRetries) {
          this.logger.error(
            `Event ${event.id} (${event.eventType}) reached max retries (${this.maxRetries}). Moving to FAILED / DLQ: ${err.message}`,
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
              error: err.message || 'Exceeded maximum retry attempts',
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
            `Event ${event.id} (${event.eventType}) failed (attempt ${newRetryCount}/${this.maxRetries}). Retrying in ${delaySec}s: ${err.message}`,
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
              error: err.message,
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

  onApplicationShutdown() {
    this.isShuttingDown = true;
    this.stopPolling();
    this.logger.log(`Outbox consumer [${this.workerId}] shut down gracefully.`);
  }
}
