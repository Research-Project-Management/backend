import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  LIBRARY_INGESTION_QUEUE,
  LIBRARY_INGESTION_JOB,
} from '../constants/queue.constants';
import { QueuedIngestionJob } from './queue.service';
import { PipelineService } from './pipeline.service';
import { IngestionRepository } from '../ingestion.repository';
import { IngestionStatus } from '@prisma/client';

@Processor(LIBRARY_INGESTION_QUEUE, { concurrency: 4 })
export class IngestionQueueConsumer
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(IngestionQueueConsumer.name);

  constructor(
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
        `IngestionQueueConsumer registered with BullMQ on queue: ${LIBRARY_INGESTION_QUEUE} (concurrency: 4)`,
      );
    } catch {
      // ignore
    }
  }

  async process(job: Job<QueuedIngestionJob>): Promise<void> {
    if (job.name !== LIBRARY_INGESTION_JOB && job.name !== '__default__') {
      this.logger.debug(`Ignoring unknown job name: ${job.name}`);
      return;
    }

    const { runId, projectId, envelope } = job.data;
    const startTime = Date.now();

    this.logger.log(
      `[BULLMQ_START] Processing ingestion job ${job.id} (run: ${runId}) for project ${projectId} (attempt: ${job.attemptsMade + 1}/${job.opts.attempts || 1})`,
    );

    try {
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
        `[BULLMQ_DONE] Ingestion run ${runId} completed successfully in ${elapsed}s`,
      );
    } catch (err: any) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);

      this.logger.error(
        `[BULLMQ_ERROR] Ingestion run ${runId} failed after ${elapsed}s (isLast: ${isLastAttempt}): ${err?.message || err}`,
      );

      if (isLastAttempt) {
        await this.repo
          .updateRunStatus(projectId, runId, IngestionStatus.FAILED_FINAL, {
            lastError:
              err?.message || 'Ingestion pipeline execution failed permanently',
          })
          .catch((updateErr: any) => {
            this.logger.error(
              `Failed to update run status for failed run ${runId}: ${updateErr?.message || updateErr}`,
            );
          });
      }

      throw err; // Allow BullMQ to handle retry backoff
    }
  }
}
