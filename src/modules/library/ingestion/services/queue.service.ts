import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestionSubmissionEnvelope } from '../types/submission.types';
import { PipelineService } from './pipeline.service';
import { IngestionRepository } from '../ingestion.repository';
import { IngestionStatus } from '@prisma/client';

export interface QueuedIngestionTask {
  runId: string;
  workspaceId: string;
  envelope: IngestionSubmissionEnvelope;
}

export interface IngestionQueueStats {
  activeCount: number;
  queuedCount: number;
  maxConcurrency: number;
}

@Injectable()
export class QueueService implements OnModuleInit {
  private readonly logger = new Logger(QueueService.name);
  private readonly queue: QueuedIngestionTask[] = [];
  private activeCount = 0;
  private readonly runningRunIds = new Set<string>();
  private readonly queuedRunIds = new Set<string>();
  private readonly maxConcurrency: number;

  constructor(
    private readonly pipeline: PipelineService,
    private readonly repo: IngestionRepository,
    @Optional() private readonly configService?: ConfigService,
  ) {
    const configuredConcurrency = Number(
      this.configService?.get('INGESTION_CONCURRENCY') ||
        process.env.INGESTION_CONCURRENCY,
    );
    // GROBID container default has 2 worker threads; 2 concurrent pipelines prevents saturation
    this.maxConcurrency =
      Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
        ? configuredConcurrency
        : 2;

    this.logger.log(
      `QueueService initialized with maxConcurrency=${this.maxConcurrency}`,
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const orphanedRuns = await this.repo.findOrphanedRuns(tenMinutesAgo, {
        limit: 20,
      });
      if (orphanedRuns.length > 0) {
        this.logger.warn(
          `Found ${orphanedRuns.length} orphaned ingestion run(s) on startup. Marking as FAILED_RETRYABLE.`,
        );
        for (const run of orphanedRuns) {
          await this.repo.updateRunStatus(
            run.workspaceId,
            run.id,
            IngestionStatus.FAILED_RETRYABLE,
            {
              lastError:
                'Pipeline interrupted by server restart. Eligible for retry.',
            },
          );
        }
      }
    } catch (err: any) {
      this.logger.error(
        `Failed to scan for orphaned ingestion runs on startup: ${err?.message}`,
      );
    }
  }

  /**
   * Enqueues an ingestion run for asynchronous pipeline execution.
   * If already running or queued, ignores to avoid duplicate work.
   */
  enqueue(
    runId: string,
    workspaceId: string,
    envelope: IngestionSubmissionEnvelope,
  ): boolean {
    if (this.runningRunIds.has(runId) || this.queuedRunIds.has(runId)) {
      this.logger.warn(
        `Run ${runId} is already active or queued. Skipping duplicate enqueue.`,
      );
      return false;
    }

    this.queuedRunIds.add(runId);
    this.queue.push({ runId, workspaceId, envelope });
    this.logger.log(
      `Enqueued run ${runId} for workspace ${workspaceId} (queue length: ${this.queue.length}, active: ${this.activeCount}/${this.maxConcurrency})`,
    );

    this.pump();
    return true;
  }

  /**
   * Checks if a run is currently executing or waiting in queue.
   */
  isProcessing(runId: string): boolean {
    return this.runningRunIds.has(runId) || this.queuedRunIds.has(runId);
  }

  /**
   * Returns current queue metrics.
   */
  getStats(): IngestionQueueStats {
    return {
      activeCount: this.activeCount,
      queuedCount: this.queue.length,
      maxConcurrency: this.maxConcurrency,
    };
  }

  /**
   * Dispatches tasks from the queue up to maxConcurrency.
   */
  private pump(): void {
    while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;

      this.queuedRunIds.delete(task.runId);
      this.runningRunIds.add(task.runId);
      this.activeCount++;

      void this.executeTask(task);
    }
  }

  /**
   * Executes an individual ingestion run through PipelineService.
   */
  private async executeTask(task: QueuedIngestionTask): Promise<void> {
    const { runId, workspaceId, envelope } = task;
    const startTime = Date.now();

    try {
      this.logger.log(
        `[QUEUE_START] Executing run ${runId} (active: ${this.activeCount}/${this.maxConcurrency}, remaining queued: ${this.queue.length})`,
      );
      await this.pipeline.executePipeline(runId, workspaceId, envelope);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(
        `[QUEUE_DONE] Run ${runId} completed successfully in ${elapsed}s`,
      );
    } catch (err: any) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.error(
        `[QUEUE_ERROR] Run ${runId} failed after ${elapsed}s: ${err?.message || err}`,
      );
      await this.repo
        .updateRunStatus(workspaceId, runId, IngestionStatus.FAILED_FINAL, {
          lastError: err?.message || 'Ingestion pipeline execution failed',
        })
        .catch((updateErr: any) => {
          this.logger.error(
            `Failed to update run status for failed run ${runId}: ${updateErr?.message || updateErr}`,
          );
        });
    } finally {
      this.runningRunIds.delete(runId);
      this.activeCount--;
      this.pump();
    }
  }
}

export { QueueService as IngestionQueueService };
