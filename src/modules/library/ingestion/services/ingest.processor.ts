import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Inject,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  forwardRef,
} from '@nestjs/common';
import { IngestionStatus } from '@prisma/client';
import { Job, UnrecoverableError } from 'bullmq';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import {
  LIBRARY_INGESTION_JOB,
  LIBRARY_INGESTION_QUEUE_STANDARD,
} from '@/modules/library/ingestion/types/ingestion.types';
import { isNonRetryableIngestionError } from '@/modules/library/ingestion/types/metadata.types';
import {
  clearRunStatusTransition,
  transitionRunToFailedIfActive,
} from './ingestion-saga.service';
import { PipelineService } from './pipeline.service';
import type { QueuedIngestionJob } from './queue.service';

@Processor(LIBRARY_INGESTION_QUEUE_STANDARD, { concurrency: 4 })
export class IngestionQueueConsumer
  extends WorkerHost
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(IngestionQueueConsumer.name);

  constructor(
    @Inject(forwardRef(() => PipelineService))
    private readonly pipeline: PipelineService,
    private readonly repo: IngestionRepository,
  ) {
    super();
  }

  onApplicationBootstrap() {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(`Ingestion Worker connection notice: ${err.message}`);
      });
      this.logger.log(
        `IngestionQueueConsumer registered with BullMQ on queue: ${LIBRARY_INGESTION_QUEUE_STANDARD} (concurrency: 4)`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `IngestionQueueConsumer worker listener skipped: ${msg}`,
      );
    }
  }

  async onApplicationShutdown() {
    try {
      if (this.worker) {
        this.logger.log(`Closing IngestionQueueConsumer worker on shutdown...`);
        await this.worker.close();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Error closing IngestionQueueConsumer worker: ${msg}`);
    }
  }

  async process(job: Job<QueuedIngestionJob>): Promise<void> {
    if (job.name !== LIBRARY_INGESTION_JOB && job.name !== '__default__') {
      this.logger.debug(`Ignoring unknown job name: ${job.name}`);
      return;
    }

    const { runId, projectId, envelope } = job.data;
    const startTime = Date.now();
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    this.logger.log(
      `[BULLMQ_START] Processing ingestion job ${job.id} (run: ${runId}) for project ${projectId} (attempt: ${job.attemptsMade + 1}/${job.opts.attempts || 1})`,
    );

    try {
      clearRunStatusTransition(runId);
      const claimed = await this.repo.transitionRunStatusAtomic(
        runId,
        [IngestionStatus.PENDING, IngestionStatus.FAILED_RETRYABLE],
        IngestionStatus.RUNNING,
      );
      if (!claimed) {
        this.logger.warn(
          `Ingestion run ${runId} is already active or in terminal status. Skipping execution.`,
        );
        return;
      }

      await this.pipeline.executePipeline(
        runId,
        projectId,
        { ...envelope, isFinalAttempt },
        { isFinalAttempt },
      );

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(
        `[BULLMQ_DONE] Ingestion run ${runId} completed successfully in ${elapsed}s`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const isTerminalFailure =
        isFinalAttempt || isNonRetryableIngestionError(err);

      this.logger.error(
        `[BULLMQ_ERROR] Ingestion run ${runId} failed after ${elapsed}s (isLast: ${isTerminalFailure}): ${msg}`,
      );

      await transitionRunToFailedIfActive({
        repo: this.repo,
        spaceId: projectId,
        runId,
        status: isTerminalFailure
          ? IngestionStatus.FAILED_FINAL
          : IngestionStatus.FAILED_RETRYABLE,
        lastError:
          msg ||
          (isTerminalFailure
            ? 'Ingestion pipeline execution failed permanently'
            : 'Ingestion pipeline execution failed (retryable)'),
        logger: this.logger,
      });

      if (isNonRetryableIngestionError(err)) {
        throw new UnrecoverableError(msg);
      }

      throw err;
    }
  }
}
