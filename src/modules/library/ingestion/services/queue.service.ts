import {
  Injectable,
  Logger,
  Optional,
  Inject,
  forwardRef,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { shouldRunWorkerConsumers } from '@/core';
import { libraryConfig } from '@/modules/library/core/config/library.config';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/ingestion.types';
import { PipelineService } from './pipeline.service';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { IngestionStatus } from '@prisma/client';
import {
  LIBRARY_INGESTION_QUEUE,
  LIBRARY_INGESTION_JOB,
} from '@/modules/library/ingestion/types/ingestion.types';
import { isRetryableIngestionError } from '@/modules/library/ingestion/types/ingestion.errors';
import {
  clearRunStatusTransition,
  transitionRunToFailedIfActive,
} from './ingestion-run-reporter.service';

export interface QueuedIngestionJob {
  runId: string;
  projectId: string;
  scopeId?: string;
  envelope: IngestionSubmissionEnvelope;
  enqueuedAt?: number;
}

export interface IngestionQueueStats {
  activeCount: number;
  queuedCount: number;
  maxConcurrency: number;
}

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  public static readonly MAX_FALLBACK_QUEUE_SIZE = 500;
  private static readonly FALLBACK_JOB_TTL_MS = 30 * 60 * 1000;

  private readonly logger = new Logger(QueueService.name);
  private readonly queue: QueuedIngestionJob[] = [];
  private activeCount = 0;
  private readonly runningRunIds = new Set<string>();
  private readonly queuedRunIds = new Set<string>();
  private readonly maxConcurrency: number;

  constructor(
    @Inject(forwardRef(() => PipelineService))
    private readonly pipeline: PipelineService,
    private readonly repo: IngestionRepository,
    @Optional() private readonly configService?: ConfigService,
    @Optional()
    @InjectQueue(LIBRARY_INGESTION_QUEUE)
    private readonly bullQueue?: Queue,
  ) {
    if (this.bullQueue?.on) {
      this.bullQueue.on('error', (err: Error) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Ingestion BullMQ queue error notice: ${message}`);
      });
    }

    const configuredConcurrency = Number(
      this.configService?.get('INGESTION_CONCURRENCY') ||
        libraryConfig().ingestion.concurrency,
    );
    // Default pipeline concurrency: 3 concurrent pipelines prevents saturation
    this.maxConcurrency =
      Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
        ? configuredConcurrency
        : 3;

    this.logger.log(
      `QueueService initialized with maxConcurrency=${this.maxConcurrency} (BullMQ: ${Boolean(this.bullQueue)})`,
    );
  }

  onModuleDestroy(): void {
    this.bullQueue?.removeAllListeners();
  }

  async onModuleInit(): Promise<void> {
    if (this.bullQueue && !shouldRunWorkerConsumers()) {
      this.logger.debug(
        'Skipping orphaned ingestion run recovery on API-only pod while BullMQ is active.',
      );
      return;
    }
    await this.recoverOrphanedRuns();
  }

  async recoverOrphanedRuns(): Promise<void> {
    try {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const orphanedRuns = await this.repo.findOrphanedRuns(tenMinutesAgo, {
        limit: 20,
      });
      if (orphanedRuns.length > 0) {
        this.logger.warn(
          `Found ${orphanedRuns.length} orphaned ingestion run(s) on startup. Marking as FAILED_RETRYABLE.`,
        );
        const CHUNK_SIZE = 25;
        for (let i = 0; i < orphanedRuns.length; i += CHUNK_SIZE) {
          const chunk = orphanedRuns.slice(i, i + CHUNK_SIZE);
          await Promise.all(
            chunk.map((run) => {
              const targetId = run.projectId || run.userId || '';
              return this.repo.updateRunStatus(
                targetId,
                run.id,
                IngestionStatus.FAILED_RETRYABLE,
                {
                  lastError:
                    'Pipeline interrupted by server restart. Eligible for retry.',
                },
              );
            }),
          );
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to scan for orphaned ingestion runs on startup: ${msg}`,
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

    const isFastPath =
      envelope?.payload?.kind === 'IDENTIFIER' ||
      envelope?.payload?.kind === 'RECORD' ||
      envelope?.payload?.kind === 'URL';
    const jobPriority = isFastPath ? 1 : 5;

    if (this.bullQueue) {
      try {
        const jobId = `ingest-${runId}`;
        if (this.bullQueue.getJob) {
          const existingJob = await this.bullQueue
            .getJob(jobId)
            .catch(() => null);
          if (existingJob?.getState) {
            const state = await existingJob.getState().catch(() => '');
            if (
              state === 'active' ||
              state === 'waiting' ||
              state === 'delayed' ||
              state === 'prioritized'
            ) {
              this.logger.warn(
                `Run ${runId} is already active or queued in BullMQ (${state}). Skipping duplicate enqueue.`,
              );
              return false;
            }
            if (existingJob.remove) {
              await existingJob.remove().catch(() => undefined);
            }
          }
        }

        // Priority routing uses BullMQ job-level priority numbers (1 = high, 5 = normal)
        // within a single standard queue — not separate physical queues.
        await this.bullQueue.add(
          LIBRARY_INGESTION_JOB,
          { runId, projectId, envelope },
          {
            jobId,
            priority: jobPriority,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 3000,
            },
            removeOnComplete: { age: 86400, count: 5000 },
            removeOnFail: { age: 7 * 86400, count: 2000 },
          },
        );
        this.logger.log(
          `[BullMQ] Enqueued run ${runId} (jobPriority=${jobPriority}, fastPath=${isFastPath}) for project ${projectId}`,
        );
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to dispatch run ${runId} to BullMQ: ${msg}. Falling back to in-memory queue.`,
        );
      }
    }

    return this.enqueueFallback(runId, projectId, envelope, isFastPath);
  }

  private enqueueFallback(
    runId: string,
    projectId: string,
    envelope: IngestionSubmissionEnvelope,
    isFastPath: boolean,
  ): boolean {
    if (this.queue.length >= QueueService.MAX_FALLBACK_QUEUE_SIZE) {
      const now = Date.now();
      const expiredIdx = this.queue.findIndex(
        (j) =>
          j.enqueuedAt !== undefined &&
          now - j.enqueuedAt > QueueService.FALLBACK_JOB_TTL_MS,
      );
      if (expiredIdx !== -1) {
        const [evicted] = this.queue.splice(expiredIdx, 1);
        if (evicted) {
          this.queuedRunIds.delete(evicted.runId);
        }
      } else {
        throw new ServiceUnavailableException(
          `Ingestion fallback queue is full (max ${QueueService.MAX_FALLBACK_QUEUE_SIZE} items). Please retry later.`,
        );
      }
    }

    const job: QueuedIngestionJob = {
      runId,
      projectId,
      envelope,
      enqueuedAt: Date.now(),
    };

    this.queuedRunIds.add(runId);
    if (isFastPath) {
      // Prioritize fast path jobs ahead of heavy file OCR/parsing jobs to prevent head-of-line blocking
      const insertIdx = this.queue.findIndex(
        (j) => j.envelope?.payload?.kind === 'FILE',
      );
      if (insertIdx !== -1) {
        this.queue.splice(insertIdx, 0, job);
      } else {
        this.queue.push(job);
      }
    } else {
      this.queue.push(job);
    }
    this.logger.log(
      `[In-Memory] Enqueued run ${runId} (fastPath=${isFastPath}) for project ${projectId} (queue length: ${this.queue.length}, active: ${this.activeCount}/${this.maxConcurrency})`,
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[QueueService] Failed to check BullMQ job state for runId "${runId}": ${msg}`,
        );
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[QueueService] Failed to fetch BullMQ queue metrics: ${msg}`,
        );
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
   * Classifies whether a pipeline error is retryable vs permanently fatal.
   */
  private isRetryablePipelineError(
    err: unknown,
    envelope?: IngestionSubmissionEnvelope,
  ): boolean {
    return isRetryableIngestionError(err, envelope, this.pipeline);
  }

  /**
   * Executes an individual ingestion run through PipelineService.
   */
  private async executeJob(job: QueuedIngestionJob): Promise<void> {
    const { runId, projectId, envelope } = job;
    const startTime = Date.now();

    try {
      clearRunStatusTransition(runId);
      this.logger.log(
        `[QUEUE_START] Executing run ${runId} (active: ${this.activeCount}/${this.maxConcurrency}, remaining queued: ${this.queue.length})`,
      );
      await this.repo
        .updateRunStatus(projectId, runId, IngestionStatus.RUNNING)
        .catch((statusErr: unknown) => {
          const msg =
            statusErr instanceof Error ? statusErr.message : String(statusErr);
          this.logger.warn(
            `Failed to set RUNNING status for run ${runId}: ${msg}`,
          );
        });
      await this.pipeline.executePipeline(runId, projectId, envelope, {
        isFinalAttempt: envelope?.isFinalAttempt,
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(
        `[QUEUE_DONE] Run ${runId} completed successfully in ${elapsed}s`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.error(
        `[QUEUE_ERROR] Run ${runId} failed after ${elapsed}s: ${msg}`,
      );
      const targetStatus = this.isRetryablePipelineError(err, envelope)
        ? IngestionStatus.FAILED_RETRYABLE
        : IngestionStatus.FAILED_FINAL;
      await transitionRunToFailedIfActive({
        repo: this.repo,
        scopeId: projectId,
        runId,
        status: targetStatus,
        lastError: msg || 'Ingestion pipeline execution failed',
        logger: this.logger,
      });
    } finally {
      this.runningRunIds.delete(runId);
      this.activeCount--;
      this.pump();
    }
  }
}
