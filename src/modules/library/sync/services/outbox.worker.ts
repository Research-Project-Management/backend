import {
  Injectable,
  Logger,
  Optional,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
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
import { ChangeLogRepository } from '../repositories/changelog.repository';
import {
  libraryConfig,
  LibraryConfigService,
} from '@/modules/library/core/config/library.config';
import { SubsystemUnavailableException } from '@/modules/library/core/errors/domain.exception';

import { OutboxDispatchHandler } from '@/modules/library/core';
import { shouldRunWorkerConsumers } from '@/core';
export type { OutboxDispatchHandler };

@Injectable()
export class OutboxWorker
  implements OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxWorker.name);
  private readonly handlers = new Map<string, OutboxDispatchHandler[]>();
  private defaultHandler?: OutboxDispatchHandler;
  private readonly maxRetries = 5;
  private static readonly CONCURRENCY = 5;
  private static readonly GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private readonly workerId: string;
  private readonly repo: OutboxRepository;

  private pollTimer: NodeJS.Timeout | null = null;
  private gcTimer: NodeJS.Timeout | null = null;
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
    @Optional() private readonly changeLogRepo?: ChangeLogRepository,
  ) {
    this.workerId = `outbox-worker-${process.pid}-${randomUUID().slice(0, 8)}`;
    if (!this.outboxRepo) {
      throw new SubsystemUnavailableException(
        'OutboxWorker requires OutboxRepository',
        { worker: 'SyncOutbox' },
      );
    }
    this.repo = this.outboxRepo;

    if (this.bullQueue) {
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
    const existing = this.handlers.get(eventType) ?? [];
    if (!existing.includes(handler)) {
      existing.push(handler);
    }
    this.handlers.set(eventType, existing);
    this.logger.log(`Registered Outbox dispatch handler for: ${eventType}`);
  }

  registerDefaultHandler(handler: OutboxDispatchHandler) {
    this.defaultHandler = handler;
    this.logger.log('Registered default fallback Outbox dispatch handler');
  }

  hasHandler(eventType: string): boolean {
    const list = this.handlers.get(eventType);
    return Boolean(list && list.length > 0);
  }

  private getEffectiveHandlers(eventType: string): OutboxDispatchHandler[] {
    const registered = this.handlers.get(eventType) ?? [];
    if (this.defaultHandler && !registered.includes(this.defaultHandler)) {
      return [...registered, this.defaultHandler];
    }
    return [...registered];
  }

  /**
   * Immediately dispatches or enqueues newly written outbox events.
   * Triggered upon PostgreSQL transaction commit from TransactionService.
   */
  async notifyEvents(eventIds: string[]): Promise<void> {
    if (!eventIds || eventIds.length === 0) return;

    const jobOpts = {
      attempts: 5,
      backoff: { type: 'exponential' as const, delay: 2000 },
      removeOnComplete: true,
    };

    if (this.bullQueue) {
      await this.bullQueue
        .addBulk(
          eventIds.map((eventId) => ({
            name: LIBRARY_OUTBOX_JOB,
            data: { eventId },
            opts: { jobId: eventId, ...jobOpts },
          })),
        )
        .catch((err: unknown) => {
          this.logger.warn(
            `Failed to bulk-enqueue ${eventIds.length} outbox event(s) to BullMQ: ${err instanceof Error ? err.message : String(err)}. Falling back to bounded poll dispatch.`,
          );
          if (eventIds.length <= OutboxWorker.CONCURRENCY) {
            for (const eventId of eventIds) {
              void this.processEventById(eventId);
            }
          } else {
            void this.pollAndProcess();
          }
        });
    } else if (eventIds.length <= OutboxWorker.CONCURRENCY) {
      for (const eventId of eventIds) {
        void this.processEventById(eventId);
      }
    } else {
      void this.pollAndProcess();
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
      this.libraryConfigService?.outbox.leaseMs ??
      (Number(this.configService?.get('OUTBOX_LEASE_MS')) ||
        libraryConfig().outbox.leaseMs);

    const claimed = await this.repo.claimSingleEvent(
      eventId,
      this.workerId,
      leaseMs,
    );
    if (!claimed) {
      return true;
    }

    const effectiveHandlers = this.getEffectiveHandlers(event.eventType);
    if (effectiveHandlers.length === 0) {
      await this.handleMissingHandler(event);
      return false;
    }

    const abortController = new AbortController();
    let isLeaseLost = false;
    const heartbeatIntervalMs = Math.max(1000, Math.floor(leaseMs / 3));
    const heartbeatTimer = setInterval(() => {
      void (async () => {
        try {
          if (!this.repo.renewLease) return;
          const renewed = await this.repo.renewLease(
            eventId,
            this.workerId,
            leaseMs,
          );
          if (!renewed) {
            isLeaseLost = true;
            abortController.abort();
            this.logger.error(
              `Worker [${this.workerId}] LOST LEASE on OutboxEvent ${eventId}. Aborting handler execution.`,
            );
            this.metricsService?.incrementCounter('outbox_lease_lost_total');
            clearInterval(heartbeatTimer);
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Heartbeat renewal failed for event ${eventId}: ${errMsg}`,
          );
        }
      })();
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();

    const start = performance.now();
    try {
      await Promise.all(
        effectiveHandlers.map((h) => h.handle(event, abortController.signal)),
      );
      clearInterval(heartbeatTimer);
      const durationMs = Math.round(performance.now() - start);

      if (isLeaseLost) {
        this.logger.error(
          `Worker [${this.workerId}] refused to publish event ${eventId} due to lost lease.`,
        );
        return false;
      }

      const published = await this.repo.markPublished(eventId, this.workerId);
      if (!published) {
        this.logger.warn(
          `[OutboxWorker] Fencing token check aborted duplicate publication for event ${eventId} (workerId: ${this.workerId}). Another worker has claimed or committed it.`,
        );
        return false;
      }
      this.metricsService?.recordOutboxDispatch(durationMs, true);
      return true;
    } catch (err: unknown) {
      clearInterval(heartbeatTimer);
      const durationMs = Math.round(performance.now() - start);
      this.metricsService?.recordOutboxDispatch(durationMs, false);
      if (isLeaseLost) {
        this.logger.error(
          `Worker [${this.workerId}] aborted error handling for event ${eventId} due to lost lease.`,
        );
        return false;
      }
      const outcome = await this.handleDispatchFailure(event, err);
      if (outcome !== 'deadLettered' && !this.bullQueue) {
        throw err;
      }
      return false;
    }
  }

  private async handleMissingHandler(event: {
    id: string;
    eventType: string;
    retryCount: number;
  }): Promise<'deadLettered' | 'retried'> {
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
      return 'deadLettered';
    }

    const delaySec = Math.pow(2, newRetryCount) * 10;
    this.logger.warn(
      `No handler registered for event type "${event.eventType}" on event ${event.id}. Retrying in ${delaySec}s (attempt ${newRetryCount}/${this.maxRetries})`,
    );
    await this.repo.scheduleRetry(
      event.id,
      newRetryCount,
      new Date(Date.now() + delaySec * 1000),
      `No handler registered for event type "${event.eventType}"`,
      this.workerId,
    );
    return 'retried';
  }

  private async handleDispatchFailure(
    event: { id: string; eventType: string; retryCount: number },
    err: unknown,
  ): Promise<'deadLettered' | 'retried'> {
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
      return 'deadLettered';
    }

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
    return 'retried';
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
          : !isTestEnv && shouldRunWorkerConsumers();

    if (isEnabled && shouldRunWorkerConsumers()) {
      const intervalMs =
        this.libraryConfigService?.outbox.pollIntervalMs ??
        (Number(this.configService?.get('OUTBOX_POLL_INTERVAL_MS')) ||
          (this.bullQueue ? 60000 : libraryConfig().outbox.pollIntervalMs));

      this.logger.log(
        `Starting runtime Outbox consumer [${this.workerId}] (interval=${intervalMs}ms)...`,
      );
      void this.logStartupDiagnostics();
      this.startPolling(intervalMs);
      this.startGcSweep();
    } else {
      this.logger.log(
        `Outbox consumer runner is disabled (NODE_ENV=${this.libraryConfigService?.app.nodeEnv ?? libraryConfig().app.nodeEnv}).`,
      );
    }
  }

  startGcSweep(intervalMs: number = OutboxWorker.GC_INTERVAL_MS) {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
    }
    this.gcTimer = setInterval(() => {
      void this.runDatabaseGarbageCollection();
    }, intervalMs);
    this.gcTimer.unref();
  }

  stopGcSweep() {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  async runDatabaseGarbageCollection(): Promise<{
    purgedPublished: number;
    purgedFailed: number;
    purgedChanges: number;
    purgedTombstones: number;
  }> {
    let purgedPublished = 0;
    let purgedFailed = 0;
    let purgedChanges = 0;
    let purgedTombstones = 0;

    try {
      const outboxRes = await this.repo.purgeProcessedOutboxEvents(3, 30, 1000);
      purgedPublished = outboxRes.purgedPublished;
      purgedFailed = outboxRes.purgedFailed;

      if (this.changeLogRepo) {
        const changeLogRes =
          await this.changeLogRepo.compactAndPurgeChangeLog(30, 1000);
        purgedChanges = changeLogRes.purgedChanges;
        purgedTombstones = changeLogRes.purgedTombstones;
      }
      if (
        purgedPublished > 0 ||
        purgedFailed > 0 ||
        purgedChanges > 0 ||
        purgedTombstones > 0
      ) {
        this.logger.log(
          `[OutboxGC] Purged ${purgedPublished} published outbox events, ${purgedFailed} failed outbox events, ${purgedChanges} change log entries, and ${purgedTombstones} tombstones.`,
        );
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Outbox database GC sweep encountered error: ${errMsg}`);
    }

    return {
      purgedPublished,
      purgedFailed,
      purgedChanges,
      purgedTombstones,
    };
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
      if (!this.hasHandler(group.eventType) && !this.defaultHandler) {
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
        this.libraryConfigService?.outbox.leaseMs ??
        (Number(this.configService?.get('OUTBOX_LEASE_MS')) ||
          libraryConfig().outbox.leaseMs);

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

  private async processClaimedItem(
    claimed: ClaimedOutboxEvent,
    leaseMs: number,
  ): Promise<{
    processed: number;
    failed: number;
    deadLettered: number;
    reclaimed: number;
  }> {
    const { event, isLeaseRecovery } = claimed;
    let processed = 0;
    let failed = 0;
    let deadLettered = 0;
    let reclaimed = 0;

    if (isLeaseRecovery) {
      reclaimed++;
      this.metricsService?.incrementCounter('outbox_lease_reclaimed_total');
      this.logger.warn(
        `Reclaimed expired PROCESSING event ${event.id} (type: ${event.eventType}, previousWorker: ${event.claimedBy || 'unknown'})`,
      );
    }

    const effectiveHandlers = this.getEffectiveHandlers(event.eventType);
    if (effectiveHandlers.length === 0) {
      const outcome = await this.handleMissingHandler(event);
      if (outcome === 'deadLettered') {
        deadLettered++;
      }
      return { processed, failed, deadLettered, reclaimed };
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
      await Promise.all(
        effectiveHandlers.map((h) => h.handle(event, abortController.signal)),
      );
      clearInterval(heartbeatTimer);

      if (isLeaseLost) {
        this.logger.error(
          `Worker [${this.workerId}] refused to publish event ${event.id} due to lost lease.`,
        );
        return { processed, failed, deadLettered, reclaimed };
      }

      const published = await this.repo.markPublished(event.id, this.workerId);
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
        return { processed, failed, deadLettered, reclaimed };
      }

      const outcome = await this.handleDispatchFailure(event, err);
      if (outcome === 'deadLettered') {
        deadLettered++;
      } else {
        failed++;
      }
    }

    return { processed, failed, deadLettered, reclaimed };
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
    if (!claimedItems || claimedItems.length === 0) {
      return { processed: 0, failed: 0, deadLettered: 0, reclaimed: 0 };
    }

    // Group claimed items by aggregateId so events for the same aggregate stay strictly ordered
    // while independent aggregates process concurrently with bounded concurrency (CONCURRENCY = 5).
    const aggregateGroups = new Map<string, ClaimedOutboxEvent[]>();
    for (const item of claimedItems) {
      const aggKey = item.event.aggregateId || item.event.id;
      let group = aggregateGroups.get(aggKey);
      if (!group) {
        group = [];
        aggregateGroups.set(aggKey, group);
      }
      group.push(item);
    }

    const groups = Array.from(aggregateGroups.values());
    let processed = 0;
    let failed = 0;
    let deadLettered = 0;
    let reclaimed = 0;
    let groupCursor = 0;

    const workerCount = Math.min(OutboxWorker.CONCURRENCY, groups.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (groupCursor < groups.length && !this.isShuttingDown) {
        const currentGroup = groups[groupCursor++];
        if (!currentGroup) break;
        for (const item of currentGroup) {
          if (this.isShuttingDown) break;
          const res = await this.processClaimedItem(item, leaseMs);
          processed += res.processed;
          failed += res.failed;
          deadLettered += res.deadLettered;
          reclaimed += res.reclaimed;
        }
      }
    });

    await Promise.all(workers);

    return { processed, failed, deadLettered, reclaimed };
  }

  onModuleDestroy() {
    this.isShuttingDown = true;
    this.stopPolling();
    this.stopGcSweep();
  }

  onApplicationShutdown() {
    this.isShuttingDown = true;
    this.stopPolling();
    this.stopGcSweep();
    this.logger.log(`Outbox consumer [${this.workerId}] shut down gracefully.`);
  }
}
