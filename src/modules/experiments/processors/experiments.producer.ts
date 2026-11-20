import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { shouldRunWorkerConsumers } from '@/core';
import {
  EXPERIMENTS_PROCESSING_QUEUE,
  EXPERIMENTS_JOB_MAINTENANCE_TRASH,
  EXPERIMENTS_JOB_PROCESS_FILE,
} from '../experiments.constant';
import { ExperimentsProcessingJobData } from '../experiments.type';

@Injectable()
export class ExperimentsQueueProducer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExperimentsQueueProducer.name);

  constructor(
    @Optional()
    @InjectQueue(EXPERIMENTS_PROCESSING_QUEUE)
    private readonly queue?: Queue,
  ) {
    if (this.queue && typeof this.queue.on === 'function') {
      this.queue.on('error', (err: Error) => {
        this.logger.warn(
          `Experiments Queue connection notice: ${err?.message || err}`,
        );
      });
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (
      process.env.EXPERIMENTS_BOOTSTRAP_LIFECYCLE === 'false' ||
      (process.env.NODE_ENV === 'production' && !shouldRunWorkerConsumers())
    ) {
      return;
    }
    await this.scheduleMaintenanceJobs();
  }

  async queueFileProcessing(data: ExperimentsProcessingJobData): Promise<void> {
    if (!this.queue) {
      this.logger.debug(
        `Experiments processing queue not configured, skipping background job for file: ${data.fileId}`,
      );
      return;
    }

    try {
      await this.queue.add(EXPERIMENTS_JOB_PROCESS_FILE, data, {
        jobId: `proc-${data.fileId}`,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });
      this.logger.log(
        `Enqueued background processing job for file ${data.fileId}`,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to enqueue experiments processing job for ${data.fileId}: ${(err as Error)?.message}`,
      );
    }
  }

  async scheduleMaintenanceJobs(): Promise<void> {
    if (!this.queue) {
      this.logger.debug('Queue not available, skipping maintenance scheduling');
      return;
    }

    const queueWithScheduler = this.queue as Queue & {
      upsertJobScheduler?(
        id: string,
        repeatOpt: { pattern: string },
        job: { name: string; opts?: Record<string, unknown> },
      ): Promise<unknown>;
    };

    const schedules = [
      {
        id: 'repeat-trash-retention',
        pattern: '0 3 * * *',
        name: EXPERIMENTS_JOB_MAINTENANCE_TRASH,
      },
    ];

    try {
      for (const s of schedules) {
        await queueWithScheduler.upsertJobScheduler?.(
          s.id,
          { pattern: s.pattern },
          {
            name: s.name,
            opts: {
              removeOnComplete: 100,
              removeOnFail: 200,
            },
          },
        );
      }

      this.logger.log(
        'Experiments trash retention repeatable job registered in BullMQ',
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to schedule experiments maintenance repeatable jobs: ${errMsg}`,
      );
    }
  }
}
