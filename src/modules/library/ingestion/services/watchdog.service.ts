import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestionStatus } from '@prisma/client';
import { IngestionRepository } from '../ingestion.repository';
import { QueueService } from './queue.service';
import { IngestionSubmissionEnvelope } from '../types/submission.types';

export interface WatchdogReconciliationResult {
  reconciled: number;
  retried: number;
  deadLettered: number;
}

@Injectable()
export class WatchdogService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WatchdogService.name);
  private timer: NodeJS.Timeout | null = null;
  public static readonly DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

  constructor(
    private readonly ingestionRepo: IngestionRepository,
    @Optional() private readonly queue?: QueueService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  onApplicationBootstrap() {
    const isTest = process.env.NODE_ENV === 'test';
    const isEnabled =
      this.configService?.get('INGESTION_WATCHDOG_ENABLED') === 'true' ||
      (!isTest && process.env.INGESTION_WATCHDOG_ENABLED !== 'false');

    if (isEnabled) {
      const intervalMs =
        Number(
          this.configService?.get('INGESTION_WATCHDOG_INTERVAL_MS') ||
            process.env.INGESTION_WATCHDOG_INTERVAL_MS,
        ) || 60000; // Check every 60s

      this.logger.log(
        `Starting Ingestion Watchdog reconciliation loop (interval=${intervalMs}ms)...`,
      );
      this.startWatchdog(intervalMs);

      // Perform an immediate startup recovery scan for abandoned runs
      void this.recoverPendingRunsOnStartup();
    }
  }

  onApplicationShutdown() {
    this.stopWatchdog();
  }

  startWatchdog(intervalMs: number) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcileOrphanedRuns().catch((err: any) => {
        this.logger.error(
          `Watchdog reconciliation failed: ${err?.message || err}`,
        );
      });
    }, intervalMs);
    // Prevent the timer from holding the Node.js event loop open in test environments.
    // Production pods are long-lived so this has no operational effect.
    this.timer.unref();
  }

  stopWatchdog() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Scans for stalled or orphaned ingestion runs and reconciles them.
   * If attempts remain, transitions to FAILED_RETRYABLE.
   * If retries are exhausted, transitions to terminal FAILED_FINAL.
   */
  async reconcileOrphanedRuns(
    workspaceId?: string,
    timeoutMs: number = WatchdogService.DEFAULT_TIMEOUT_MS,
  ): Promise<WatchdogReconciliationResult> {
    const olderThan = new Date(Date.now() - timeoutMs);
    const orphanedRuns = await this.ingestionRepo.findOrphanedRuns(olderThan, {
      workspaceId,
      limit: 100,
    });

    if (orphanedRuns.length === 0) {
      return { reconciled: 0, retried: 0, deadLettered: 0 };
    }

    this.logger.warn(
      `Watchdog detected ${orphanedRuns.length} orphaned/stalled ingestion run(s) older than ${timeoutMs / 1000}s`,
    );

    let retried = 0;
    let deadLettered = 0;

    for (const run of orphanedRuns) {
      const nextAttempt = run.attempts + 1;
      const canRetry = nextAttempt < run.maxRetries;

      if (canRetry) {
        await this.ingestionRepo.reconcileRun(run.workspaceId, run.id, {
          status: IngestionStatus.FAILED_RETRYABLE,
          lastError: `Ingestion run stalled at status ${run.status} after ${timeoutMs / 1000}s. Reconciled by watchdog for retry.`,
          attemptsIncrement: true,
          completedAt: null,
        });
        retried++;
        this.logger.log(
          `Reconciled stalled run ${run.id} as FAILED_RETRYABLE (attempt ${nextAttempt}/${run.maxRetries})`,
        );

        // Active recovery: automatically dispatch back to QueueService
        if (this.queue && run.inputParams) {
          const envelope =
            run.inputParams as unknown as IngestionSubmissionEnvelope;
          if (envelope && typeof envelope === 'object') {
            this.queue.enqueue(run.id, run.workspaceId, {
              ...envelope,
              workspaceId: run.workspaceId,
            });
            this.logger.log(
              `Watchdog auto-retried stalled run ${run.id} into ingestion queue`,
            );
          }
        }
      } else {
        await this.ingestionRepo.reconcileRun(run.workspaceId, run.id, {
          status: IngestionStatus.FAILED_FINAL,
          lastError: `Ingestion run stalled at status ${run.status} and exhausted maximum retries (${run.maxRetries}). Marked failed by watchdog.`,
          attemptsIncrement: true,
          completedAt: new Date(),
        });
        deadLettered++;
        this.logger.error(
          `Marked stalled run ${run.id} as FAILED_FINAL (exhausted ${run.maxRetries} retries)`,
        );
      }
    }

    return {
      reconciled: orphanedRuns.length,
      retried,
      deadLettered,
    };
  }

  /**
   * Scans for orphaned or stalled runs left behind after an abrupt pod/process restart,
   * and automatically enqueues them back into QueueService.
   */
  async recoverPendingRunsOnStartup(): Promise<number> {
    if (!this.queue) return 0;

    try {
      // Look back up to 24 hours for abandoned runs
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const pendingRuns = await this.ingestionRepo.findRecoverableRuns(
        since,
        50,
      );

      if (pendingRuns.length === 0) return 0;

      let recovered = 0;
      for (const run of pendingRuns) {
        if (!run.inputParams || run.attempts >= run.maxRetries) continue;
        const envelope =
          run.inputParams as unknown as IngestionSubmissionEnvelope;
        if (!envelope || typeof envelope !== 'object') continue;

        const enqueued = this.queue.enqueue(run.id, run.workspaceId, {
          ...envelope,
          workspaceId: run.workspaceId,
        });
        if (enqueued) {
          recovered++;
          this.logger.log(
            `Startup recovery: re-enqueued abandoned run ${run.id} (${run.status}) in workspace ${run.workspaceId}`,
          );
        }
      }

      if (recovered > 0) {
        this.logger.log(
          `Startup recovery complete: safely re-enqueued ${recovered} orphaned run(s)`,
        );
      }
      return recovered;
    } catch (err: any) {
      this.logger.error(`Startup recovery scan failed: ${err?.message || err}`);
      return 0;
    }
  }
}

export { WatchdogService as IngestionWatchdogService };
