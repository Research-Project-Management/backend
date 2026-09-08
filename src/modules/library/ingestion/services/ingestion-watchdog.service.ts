import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestionStatus } from '@prisma/client';
import { IngestionRepository } from '../ingestion.repository';

export interface WatchdogReconciliationResult {
  reconciled: number;
  retried: number;
  deadLettered: number;
}

@Injectable()
export class IngestionWatchdogService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(IngestionWatchdogService.name);
  private timer: NodeJS.Timeout | null = null;
  public static readonly DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

  constructor(
    private readonly ingestionRepo: IngestionRepository,
    private readonly configService?: ConfigService,
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
    timeoutMs: number = IngestionWatchdogService.DEFAULT_TIMEOUT_MS,
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
}
