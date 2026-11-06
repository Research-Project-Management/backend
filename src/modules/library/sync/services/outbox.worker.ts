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
import { OutboxStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  LIBRARY_OUTBOX_QUEUE,
  LIBRARY_OUTBOX_JOB,
  OutboxDispatchHandler,
} from '@/modules/library/core';
import {
  OutboxRepository,
  ClaimedOutboxEvent,
  handleMissingOutboxHandler,
  handleOutboxDispatchFailure,
  executeOutboxGarbageCollection,
  buildOutboxDiagnosticSummary,
} from '../repositories/outbox.repository';
import { ChangeLogRepository } from '../repositories/changelog.repository';
import {
  libraryConfig,
  LibraryConfigService,
} from '@/modules/library/core/config/library.config';
import { SubsystemUnavailableException } from '@/modules/library/core/errors/domain.exception';
import { shouldRunWorkerConsumers } from '@/core';
import { OutboxMetrics } from './outbox-metrics.service';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import {
  OutboxQueueConsumer,
  OutboxBullProcessor,
} from './outbox.processor';

export type { OutboxDispatchHandler };
export {
  OutboxMetrics,
  OutboxDispatcher,
  OutboxQueueConsumer,
  OutboxBullProcessor,
};

@Injectable()
export class OutboxWorker
  implements OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxWorker.name);
  private readonly handlers = new Map<string, OutboxDispatchHandler[]>();
  private readonly completedHandlersByEvent = new Map<
    string,
    Set<OutboxDispatchHandler>
  >();
  private defaultHandler?: OutboxDispatchHandler;
  private readonly maxRetries = 5;
  private static readonly CONCURRENCY = 5;
  private static readonly GC_INTERVAL_MS = 60 * 60 * 1000;
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
    const specialized = registered.filter((h) => h !== this.defaultHandler);
    if (specialized.length > 0) {
      return specialized;
    }
    if (this.defaultHandler) {
      return [this.defaultHandler];
    }
    return [...registered];
  }

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
              void this.processEventById(eventId).catch((e: unknown) => {
                this.logger.warn(
                  `Background outbox dispatch failed for ${eventId}: ${e instanceof Error ? e.message : String(e)}`,
                );
              });
            }
          } else {
            void this.pollAndProcess();
          }
        });
    } else if (eventIds.length <= OutboxWorker.CONCURRENCY) {
      for (const eventId of eventIds) {
        void this.processEventById(eventId).catch((e: unknown) => {
          this.logger.warn(
            `Background outbox dispatch failed for ${eventId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      }
    } else {
      void this.pollAndProcess();
    }
  }

  async processEventById(
    eventId: string,
    options?: { rethrowOnRetryableFailure?: boolean },
  ): Promise<boolean> {
    const initialEvent = await this.repo.findById(eventId);
    if (!initialEvent || initialEvent.status === OutboxStatus.PUBLISHED) {
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
      Boolean(options?.rethrowOnRetryableFailure),
    );
    if (!claimed) return true;

    // Reload event after claim so retryCount, claimedBy, and leaseExpiresAt reflect the claim update
    const event = (await this.repo.findById(eventId)) ?? initialEvent;
    if (event.status === OutboxStatus.PUBLISHED) {
      return true;
    }

    const effectiveHandlers = this.getEffectiveHandlers(event.eventType);
    if (effectiveHandlers.length === 0) {
      const outcome = await this.handleMissingHandler(event);
      if (outcome !== 'deadLettered' && options?.rethrowOnRetryableFailure) {
        throw new SubsystemUnavailableException(
          `No handler registered for outbox event type "${event.eventType}"`,
          { eventType: event.eventType },
        );
      }
      return false;
    }

    const result = await this.executeWithLeaseHeartbeat(
      event,
      leaseMs,
      effectiveHandlers,
      { recordDispatchMetrics: true },
    );

    if (result.status === 'published') return true;
    if (result.status === 'fencingAborted') {
      this.logger.warn(
        `[OutboxWorker] Fencing token check aborted duplicate publication for event ${eventId} (workerId: ${this.workerId}). Another worker has claimed or committed it.`,
      );
      return false;
    }
    if (
      result.status === 'failed' &&
      result.outcome !== 'deadLettered' &&
      options?.rethrowOnRetryableFailure
    ) {
      throw result.error;
    }
    return false;
  }

  private async executeWithLeaseHeartbeat(
    event: ClaimedOutboxEvent['event'],
    leaseMs: number,
    effectiveHandlers: OutboxDispatchHandler[],
    options?: { recordDispatchMetrics?: boolean },
  ): Promise<
    | { status: 'published' }
    | { status: 'leaseLost' }
    | { status: 'fencingAborted' }
    | { status: 'failed'; outcome: 'deadLettered' | 'retried'; error: unknown }
  > {
    const abortController = new AbortController();
    let isLeaseLost = false;
    const heartbeatIntervalMs = Math.max(1000, Math.floor(leaseMs / 3));
    const heartbeatTimer = setInterval(() => {
      void (async () => {
        try {
          if (!this.repo.renewLease) return;
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

    const start = performance.now();
    try {
      const completedSet =
        this.completedHandlersByEvent.get(event.id) ??
        new Set<OutboxDispatchHandler>();
      const remainingHandlers = effectiveHandlers.filter(
        (h) => !completedSet.has(h),
      );

      for (const handler of remainingHandlers) {
        if (abortController.signal.aborted || isLeaseLost) {
          throw new SubsystemUnavailableException(
            `Handler execution aborted for event ${event.id} (lease lost)`,
            { eventId: event.id },
          );
        }
        await handler.handle(event, abortController.signal);
        completedSet.add(handler);
        if (this.completedHandlersByEvent.size > 2000) {
          const oldestKey = this.completedHandlersByEvent.keys().next().value;
          if (oldestKey) this.completedHandlersByEvent.delete(oldestKey);
        }
        this.completedHandlersByEvent.set(event.id, completedSet);
      }

      clearInterval(heartbeatTimer);
      const durationMs = Math.round(performance.now() - start);

      if (isLeaseLost || abortController.signal.aborted) {
        this.logger.error(
          `Worker [${this.workerId}] refused to publish event ${event.id} due to lost lease.`,
        );
        return { status: 'leaseLost' };
      }

      const published = await this.repo.markPublished(event.id, this.workerId);
      this.completedHandlersByEvent.delete(event.id);
      if (!published) return { status: 'fencingAborted' };
      if (options?.recordDispatchMetrics) {
        this.metricsService?.recordOutboxDispatch(durationMs, true);
      }
      return { status: 'published' };
    } catch (err: unknown) {
      clearInterval(heartbeatTimer);
      const durationMs = Math.round(performance.now() - start);
      if (options?.recordDispatchMetrics) {
        this.metricsService?.recordOutboxDispatch(durationMs, false);
      }
      if (isLeaseLost || abortController.signal.aborted) {
        this.logger.error(
          `Worker [${this.workerId}] aborted error handling for event ${event.id} due to lost lease.`,
        );
        return { status: 'leaseLost' };
      }
      const outcome = await this.handleDispatchFailure(event, err);
      if (outcome === 'deadLettered') {
        this.completedHandlersByEvent.delete(event.id);
      }
      return { status: 'failed', outcome, error: err };
    }
  }

  private async handleMissingHandler(event: {
    id: string;
    eventType: string;
    retryCount: number;
  }): Promise<'deadLettered' | 'retried'> {
    return handleMissingOutboxHandler({
      event,
      maxRetries: this.maxRetries,
      workerId: this.workerId,
      repo: this.repo,
      logger: this.logger,
      metricsService: this.metricsService,
    });
  }

  private async handleDispatchFailure(
    event: { id: string; eventType: string; retryCount: number },
    err: unknown,
  ): Promise<'deadLettered' | 'retried'> {
    return handleOutboxDispatchFailure({
      event,
      err,
      maxRetries: this.maxRetries,
      workerId: this.workerId,
      repo: this.repo,
      logger: this.logger,
      metricsService: this.metricsService,
    });
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
    if (this.gcTimer) clearInterval(this.gcTimer);
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
    return executeOutboxGarbageCollection({
      repo: this.repo,
      changeLogRepo: this.changeLogRepo,
      logger: this.logger,
    });
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
    return buildOutboxDiagnosticSummary({
      workerId: this.workerId,
      registeredHandlers: Array.from(this.handlers.keys()),
      hasHandler: (et) => this.hasHandler(et),
      hasDefaultHandler: Boolean(this.defaultHandler),
      repo: this.repo,
      metricsService: this.metricsService,
    });
  }

  startPolling(intervalMs: number = 2000) {
    if (this.pollTimer) clearInterval(this.pollTimer);
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
      if (event.retryCount >= this.maxRetries) {
        await this.repo.markDeadLetter(
          event.id,
          event.retryCount,
          'Lease expired repeatedly (poison event)',
          this.workerId,
        );
        deadLettered++;
        return { processed, failed, deadLettered, reclaimed };
      }
    }

    const effectiveHandlers = this.getEffectiveHandlers(event.eventType);
    if (effectiveHandlers.length === 0) {
      const outcome = await this.handleMissingHandler(event);
      if (outcome === 'deadLettered') deadLettered++;
      return { processed, failed, deadLettered, reclaimed };
    }

    const result = await this.executeWithLeaseHeartbeat(
      event,
      leaseMs,
      effectiveHandlers,
    );

    if (result.status === 'published') {
      processed++;
    } else if (result.status === 'fencingAborted') {
      this.logger.warn(
        `Worker [${this.workerId}] lost claim before publishing event ${event.id}.`,
      );
      this.metricsService?.incrementCounter('outbox_lease_lost_total');
    } else if (result.status === 'failed') {
      if (result.outcome === 'deadLettered') {
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

    // Keep leases alive for claimed events waiting in the batch queue so slow earlier events
    // do not cause queued items to expire their lease before processClaimedItem starts
    const waitingEventIds = new Set<string>(
      claimedItems.map((item) => item.event.id),
    );
    const batchHeartbeatIntervalMs = Math.max(1000, Math.floor(leaseMs / 3));
    const batchHeartbeatTimer = setInterval(() => {
      if (waitingEventIds.size === 0 || !this.repo.renewLease) return;
      for (const waitingId of Array.from(waitingEventIds)) {
        void this.repo
          .renewLease(waitingId, this.workerId, leaseMs)
          .catch(() => undefined);
      }
    }, batchHeartbeatIntervalMs);
    batchHeartbeatTimer.unref?.();

    try {
      const workerCount = Math.min(OutboxWorker.CONCURRENCY, groups.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (groupCursor < groups.length && !this.isShuttingDown) {
          const currentGroup = groups[groupCursor++];
          if (!currentGroup) break;
          for (const item of currentGroup) {
            if (this.isShuttingDown) break;
            waitingEventIds.delete(item.event.id);
            const res = await this.processClaimedItem(item, leaseMs);
            processed += res.processed;
            failed += res.failed;
            deadLettered += res.deadLettered;
            reclaimed += res.reclaimed;
          }
        }
      });

      await Promise.all(workers);
    } finally {
      clearInterval(batchHeartbeatTimer);
    }
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
