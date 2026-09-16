import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  STORAGE_PROCESSING_QUEUE,
  STORAGE_JOB_PROCESS_FILE,
  STORAGE_JOB_MAINTENANCE_TRASH,
  STORAGE_JOB_MAINTENANCE_MULTIPART,
  STORAGE_JOB_MAINTENANCE_ORPHAN,
  StorageProcessingJobData,
} from './storage-queue.types';

@Injectable()
export class StorageQueueProducer {
  private readonly logger = new Logger(StorageQueueProducer.name);

  constructor(
    @Optional()
    @InjectQueue(STORAGE_PROCESSING_QUEUE)
    private readonly queue?: Queue,
  ) {
    if (this.queue && typeof (this.queue as any).on === 'function') {
      (this.queue as any).on('error', (err: any) => {
        this.logger.warn(`Storage Queue connection notice: ${err?.message || err}`);
      });
    }
  }

  async queueFileProcessing(data: StorageProcessingJobData): Promise<void> {
    if (!this.queue) {
      this.logger.debug(
        `Storage processing queue not configured, skipping background job for file: ${data.fileId}`,
      );
      return;
    }

    try {
      await this.queue.add(STORAGE_JOB_PROCESS_FILE, data, {
        jobId: `proc-${data.fileId}`,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });
      this.logger.log(`Enqueued background processing job for file ${data.fileId}`);
    } catch (err: any) {
      this.logger.warn(
        `Failed to enqueue storage processing job for ${data.fileId}: ${err?.message}`,
      );
    }
  }

  async scheduleMaintenanceJobs(): Promise<void> {
    if (!this.queue) {
      this.logger.debug('Queue not available, skipping maintenance scheduling');
      return;
    }

    try {
      // 1. Trash retention: run daily at 03:00 UTC
      await (this.queue as any).upsertJobScheduler?.(
        'repeat-trash-retention',
        { pattern: '0 3 * * *' },
        {
          name: STORAGE_JOB_MAINTENANCE_TRASH,
          opts: {
            removeOnComplete: 100,
            removeOnFail: 200,
          },
        },
      );

      // 2. Multipart cleanup: run every 6 hours
      await (this.queue as any).upsertJobScheduler?.(
        'repeat-multipart-cleanup',
        { pattern: '0 */6 * * *' },
        {
          name: STORAGE_JOB_MAINTENANCE_MULTIPART,
          opts: {
            removeOnComplete: 100,
            removeOnFail: 200,
          },
        },
      );

      // 3. Orphan blob GC: run daily at 04:00 UTC
      await (this.queue as any).upsertJobScheduler?.(
        'repeat-orphan-blob',
        { pattern: '0 4 * * *' },
        {
          name: STORAGE_JOB_MAINTENANCE_ORPHAN,
          opts: {
            removeOnComplete: 100,
            removeOnFail: 200,
          },
        },
      );

      this.logger.log(
        'Storage maintenance repeatable jobs registered in BullMQ (Trash Retention, Multipart Cleanup, Orphan Blob GC)',
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to schedule storage maintenance repeatable jobs: ${err?.message}`,
      );
    }
  }

  async triggerMaintenance(jobName: string): Promise<void> {
    if (!this.queue) return;
    await this.queue.add(jobName, {}, {
      jobId: `manual-${jobName}-${Date.now()}`,
    });
  }
}
