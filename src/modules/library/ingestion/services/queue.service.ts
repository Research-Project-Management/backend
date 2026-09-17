import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { IngestionSubmissionEnvelope } from '../types/submission.types';
import { PipelineService } from './pipeline.service';
import { IngestionRepository } from '../ingestion.repository';
import { IngestionStatus } from '@prisma/client';
import { LIBRARY_INGESTION_QUEUE, LIBRARY_INGESTION_JOB } from '../constants/queue.constants';

export interface QueuedIngestionJob {
  runId: string;
  projectId: string;
  scopeId?: string;
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
  private readonly queue: QueuedIngestionJob[] = [];
  private activeCount = 0;
  private readonly runningRunIds = new Set<string>();
  private readonly queuedRunIds = new Set<string>();
  private readonly maxConcurrency: number;

  constructor(
    private readonly pipeline: PipelineService,
    private readonly repo: IngestionRepository,
    @Optional() private readonly configService?: ConfigService,
    @Optional()
    @InjectQueue(LIBRARY_INGESTION_QUEUE)
    private readonly bullQueue?: Queue,
  ) {
    if (this.bullQueue && typeof (this.bullQueue as any).on === 'function') {
      (this.bullQueue as any).on('error', (err: any) => {
        this.logger.warn(`Ingestion BullMQ queue error notice: ${err?.message || err}`);
      });
    }

    const configuredConcurrency = Number(
      this.configService?.get('INGESTION_CONCURRENCY') ||
        process.env.INGESTION_CONCURRENCY,
    );
    // GROBID container default has 2 worker threads; 3 concurrent pipelines prevents saturation
    this.maxConcurrency =
      Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
        ? configuredConcurrency
        : 3;

    this.logger.log(
      `QueueService initialized with maxConcurrency=${this.maxConcurrency} (BullMQ: ${Boolean(this.bullQueue)})`,
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
          const targetId = run.projectId || run.userId || '';
          await this.repo.updateRunStatus(
            targetId,
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
   * If BullMQ is available, dispatches to Redis distributed queue.
   * Otherwise falls back to bounded in-memory queue.
   */
  async enqueue(
    runId: string,
    projectId: string,
    envelope: IngestionSubmissionEnvelope,
  ): Promise<boolean> {
    if (this.isProcessingSync(runId)) {
      this.logger.warn(
        `Run ${runId} is already active or queued. Skipping duplicate enqueue.`,
      );
      return false;
    }

    if (this.bullQueue) {
      try {
        await this.bullQueue.add(
          LIBRARY_INGESTION_JOB,
          { runId, projectId, envelope },
          {
            jobId: `ingest-${runId}`,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 3000,
            },
            removeOnComplete: { age: 86400, count: 5000 },
            removeOnFail: { age: 7 * 86400, count: 2000 },
          },
        );
        this.queuedRunIds.add(runId);
        this.logger.log(
          `[BullMQ] Enqueued run ${runId} for project ${projectId} into Redis queue ${LIBRARY_INGESTION_QUEUE}`,
        );
        return true;
      } catch (err: any) {
        this.logger.error(
          `Failed to dispatch run ${runId} to BullMQ: ${err?.message || err}. Falling back to in-memory queue.`,
        );
      }
    }

    this.queuedRunIds.add(runId);
    this.queue.push({ runId, projectId, envelope });
    this.logger.log(
      `[In-Memory] Enqueued run ${runId} for project ${projectId} (queue length: ${this.queue.length}, active: ${this.activeCount}/${this.maxConcurrency})`,
    );

    this.pump();
    return true;
  }

  /**
   * Synchronous check against local in-memory sets.
   */
  isProcessingSync(runId: string): boolean {
    return this.runningRunIds.has(runId) || this.queuedRunIds.has(runId);
  }

  /**
   * Checks if a run is currently executing or waiting in queue (checks memory and Redis).
   */
  async isProcessing(runId: string): Promise<boolean> {
    if (this.isProcessingSync(runId)) {
      return true;
    }
    if (this.bullQueue) {
      try {
        const job = await this.bullQueue.getJob(`ingest-${runId}`);
        if (job) {
          const state = await job.getState();
          return (
            state === 'active' ||
            state === 'waiting' ||
            state === 'delayed' ||
            state === 'prioritized'
          );
        }
      } catch {
        // ignore redis error
      }
    }
    return false;
  }

  /**
   * Returns current queue metrics.
   */
  async getStats(): Promise<IngestionQueueStats> {
    let bullActive = 0;
    let bullWaiting = 0;
    if (this.bullQueue) {
      try {
        [bullActive, bullWaiting] = await Promise.all([
          this.bullQueue.getActiveCount(),
          this.bullQueue.getWaitingCount(),
        ]);
      } catch {
        // ignore
      }
    }
    return {
      activeCount: this.activeCount + bullActive,
      queuedCount: this.queue.length + bullWaiting,
      maxConcurrency: this.maxConcurrency,
    };
  }

  /**
   * Dispatches jobs from the queue up to maxConcurrency.
   */
  private pump(): void {
    while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;

      this.queuedRunIds.delete(job.runId);
      this.runningRunIds.add(job.runId);
      this.activeCount++;

      void this.executeJob(job);
    }
  }

  /**
   * Executes an individual ingestion run through PipelineService.
   */
  private async executeJob(job: QueuedIngestionJob): Promise<void> {
    const { runId, projectId, envelope } = job;
    const startTime = Date.now();

    try {
      this.logger.log(
        `[QUEUE_START] Executing run ${runId} (active: ${this.activeCount}/${this.maxConcurrency}, remaining queued: ${this.queue.length})`,
      );
      await this.repo
        .updateRunStatus(projectId, runId, IngestionStatus.DETECTED)
        .catch((statusErr: any) => {
          this.logger.warn(
            `Failed to set DETECTED status for run ${runId}: ${statusErr?.message}`,
          );
        });
      await this.pipeline.executePipeline(runId, projectId, envelope);
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
        .updateRunStatus(projectId, runId, IngestionStatus.FAILED_FINAL, {
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
