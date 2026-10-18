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
import { OutboxMetrics } from './outbox.metrics';
import { OutboxStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  LIBRARY_OUTBOX_QUEUE,
  LIBRARY_OUTBOX_JOB,
} from '@/modules/library/sync/types/outbox.constants';
import {
  OutboxRepository,
  ClaimedOutboxEvent,
} from '../repositories/outbox.repository';
import {
  libraryConfig,
  LibraryConfigService,
} from '@/modules/library/core/config/library.config';
import { SubsystemUnavailableException } from '@/modules/library/core/errors/domain.exception';

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
  private readonly repo: OutboxRepository;

  private pollTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isShuttingDown = false;

  constructor(
    @Optional() private readonly outboxRepo?: OutboxRepository,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly libraryConfigService?: LibraryConfigService,
    @Optional() private readonly metricsService?: OutboxMetrics,
    @Optional()
    @InjectQueue(LIBRARY_OUTBOX_QUEUE)
    private readonly bullQueue?: Queue,
  ) {
    this.workerId = `outbox-worker-${process.pid}-${randomUUID().slice(0, 8)}`;
    if (!this.outboxRepo) {
      throw new SubsystemUnavailableException(
        'OutboxWorker requires OutboxRepository',
        { worker: 'SyncOutbox' },
      );
    }
    this.repo = this.outboxRepo;

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
        .catch((err: unknown) => {
          this.logger.warn(
            `Failed to bulk-enqueue ${eventIds.length} outbox event(s) to BullMQ: ${err instanceof Error ? err.message : String(err)}. Falling back to direct dispatch.`,
          );
          for (const eventId of eventIds) {
            void this.processEventById(eventId);
          }
        });
    } else {
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
    const event = await this.repo.findById(eventId);

    if (!event || event.status === OutboxStatus.PUBLISHED) {
      return true;
    }

    const leaseMs =
      this.libraryConfigService?.outbox.lockTtlMs ??
      (Number(this.configService?.get('OUTBOX_LEASE_MS')) ||
        libraryConfig().outbox.lockTtlMs);

    const claimed = await this.repo.claimSingleEvent(
      eventId,
      this.workerId,
      leaseMs,
    );
    if (!claimed) {
      return true;
    }

    const handler = this.handlers.get(event.eventType) || this.defaultHandler;
    if (!handler) {
      const newRetryCount = event.retryCount + 1;
      const isMax = newRetryCount >= this.maxRetries;
      await this.repo.markMissingHandler(
        eventId,
        newRetryCount,
        isMax,
        event.eventType,
      );
      return false;
    }

    const start = performance.now();
    try {
      await handler.handle(event);
      const durationMs = Math.round(performance.now() - start);

      await this.repo.markPublished(eventId, this.workerId);

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

      await this.repo.markFailed(eventId, newRetryCount, isMax, errMsg);

      this.metricsService?.recordOutboxDispatch(durationMs, false);
      this.metricsService?.incrementCounter('outbox_retry_total');
      if (isMax) {
        this.metricsService?.incrementCounter('outbox_dlq_total');
      }
      throw err;
    }
  }

  onApplicationBootstrap() {
    const isTestEnv =
      this.libraryConfigService?.app.isTest ?? libraryConfig().app.isTest;
    const configEnabled = this.configService?.get<string>(
      'OUTBOX_WORKER_ENABLED',
    );
    const envEnabled =
      this.libraryConfigService?.outbox.workerEnabled ??
      libraryConfig().outbox.workerEnabled;

    const isEnabled =
      configEnabled !== undefined
        ? configEnabled === 'true'
        : envEnabled !== undefined
          ? envEnabled === 'true'
          : !isTestEnv;

    if (isEnabled) {
      const intervalMs =
        this.libraryConfigService?.outbox.pollIntervalMs ??
        (Number(this.configService?.get('OUTBOX_POLL_INTERVAL_MS')) ||
          (this.bullQueue ? 60000 : libraryConfig().outbox.pollIntervalMs));

      this.logger.log(
        `Starting runtime Outbox consumer [${this.workerId}] (interval=${intervalMs}ms)...`,
      );
      void this.logStartupDiagnostics();
      this.startPolling(intervalMs);
    } else {
      this.logger.log(
        `Outbox consumer runner is disabled (NODE_ENV=${this.libraryConfigService?.app.nodeEnv ?? libraryConfig().app.nodeEnv}).`,
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

    const { groupedPending, oldestPendingCreatedAt, processingCount } =
      await this.repo.getDiagnosticData();

    if (oldestPendingCreatedAt) {
      oldestPendingAgeSeconds = Math.max(
        0,
        Math.floor((now.getTime() - oldestPendingCreatedAt.getTime()) / 1000),
      );
    }

    for (const group of groupedPending) {
      pendingCountsByType[group.eventType] = group.count;
      totalPending += group.count;
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

  startPolling(intervalMs: number = 2000) {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.pollTimer = setInterval(() => {
      void this.pollAndProcess();
    }, intervalMs);
    this.pollTimer.unref();
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollAndProcess(): Promise<void> {
    if (this.isProcessing || this.isShuttingDown) return;
    this.isProcessing = true;

    try {
      const batchSize =
        this.libraryConfigService?.outbox.batchSize ??
        (Number(this.configService?.get('OUTBOX_BATCH_SIZE')) ||
          libraryConfig().outbox.batchSize);
      const leaseMs =
        this.libraryConfigService?.outbox.lockTtlMs ??
        (Number(this.configService?.get('OUTBOX_LEASE_MS')) ||
          libraryConfig().outbox.lockTtlMs);

      await this.processPendingEvents(batchSize, leaseMs);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error during outbox polling run: ${errMsg}`);
    } finally {
      this.isProcessing = false;
    }
  }

  async claimBatch(
    batchSize: number = 50,
    leaseMs: number = 60000,
  ): Promise<ClaimedOutboxEvent[]> {
    return this.repo.claimBatch(batchSize, leaseMs, this.workerId);
  }

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

      const handler = this.handlers.get(event.eventType) || this.defaultHandler;
      if (!handler) {
        const newRetryCount = event.retryCount + 1;
        this.metricsService?.incrementCounter('outbox_unhandled_event_total');

        if (newRetryCount >= this.maxRetries) {
          this.logger.error(
            `Unrecognized event type "${event.eventType}" on event ${event.id} reached max retries (${this.maxRetries}). Moving to DLQ.`,
          );
          this.metricsService?.incrementCounter('outbox_dlq_total');
          await this.repo.markDeadLetter(
            event.id,
            newRetryCount,
            `No handler registered for event type "${event.eventType}"`,
            this.workerId,
          );
          deadLettered++;
        } else {
          const delaySec = Math.pow(2, newRetryCount) * 10;
          this.logger.warn(
            `No handler registered for event type "${event.eventType}" on event ${event.id}. Retrying in ${delaySec}s (attempt ${newRetryCount}/${this.maxRetries})`,
          );
          await this.repo.scheduleRetry(
            event.id,
            newRetryCount,
            new Date(Date.now() + delaySec * 1000),
            undefined,
            this.workerId,
          );
        }
        continue;
      }

      const abortController = new AbortController();
      let isLeaseLost = false;
      const heartbeatIntervalMs = Math.max(1000, Math.floor(leaseMs / 3));
      const heartbeatTimer = setInterval(() => {
        void (async () => {
          try {
            const renewed = await this.repo.renewLease(
              event.id,
              this.workerId,
              leaseMs,
            );
            if (!renewed) {
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

      try {
        await handler.handle(event, abortController.signal);
        clearInterval(heartbeatTimer);

        if (isLeaseLost) {
          this.logger.error(
            `Worker [${this.workerId}] refused to publish event ${event.id} due to lost lease.`,
          );
          continue;
        }

        const published = await this.repo.markPublished(
          event.id,
          this.workerId,
        );
        if (!published) {
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
          await this.repo.markDeadLetter(
            event.id,
            newRetryCount,
            errMsg || 'Exceeded maximum retry attempts',
            this.workerId,
          );
          deadLettered++;
        } else {
          const delaySec = Math.pow(2, newRetryCount);
          const nextSchedule = new Date(Date.now() + delaySec * 1000);

          this.logger.warn(
            `Event ${event.id} (${event.eventType}) failed (attempt ${newRetryCount}/${this.maxRetries}). Retrying in ${delaySec}s: ${errMsg}`,
          );

          await this.repo.scheduleRetry(
            event.id,
            newRetryCount,
            nextSchedule,
            errMsg,
            this.workerId,
          );
          failed++;
        }
      }
    }

    return { processed, failed, deadLettered, reclaimed };
  }

  async purgeCompletedEvents(
    olderThanMs: number = 7 * 24 * 60 * 60 * 1000,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const count = await this.repo.cleanupPublished(cutoff);
    if (count > 0) {
      this.logger.log(
        `Purged ${count} completed outbox events older than ${cutoff.toISOString()}`,
      );
    }
    return count;
  }

  onApplicationShutdown() {
    this.isShuttingDown = true;
    this.stopPolling();
    this.logger.log(`Outbox consumer [${this.workerId}] shut down gracefully.`);
  }
}
