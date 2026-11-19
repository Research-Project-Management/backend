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
  FILES_JOB_CLEANUP_EXPIRED_SESSIONS,
  FILES_JOB_RECLAIM_ORPHAN_BLOBS,
  FILES_MAINTENANCE_QUEUE,
} from '../files.constant';
import { BlobService } from '../services/blob.service';
import { StorageLifecycleConfiguration } from '../types/adapter.type';

/**
 * Self-contained physical storage lifecycle & maintenance scheduler for FilesModule.
 * Initializes bucket lifecycle rules and registers BullMQ repeatable jobs for
 * abandoned multipart session cleanup and atomic CAS orphan blob GC.
 */
@Injectable()
export class FilesLifecycleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FilesLifecycleService.name);

  constructor(
    private readonly blobService: BlobService,
    @Optional()
    @InjectQueue(FILES_MAINTENANCE_QUEUE)
    private readonly queue?: Queue,
  ) {
    if (this.queue && typeof this.queue.on === 'function') {
      this.queue.on('error', (err: Error) => {
        this.logger.warn(
          `Files maintenance queue connection notice: ${err?.message || err}`,
        );
      });
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (
      process.env.FILES_BOOTSTRAP_LIFECYCLE === 'false' ||
      (process.env.NODE_ENV === 'production' && !shouldRunWorkerConsumers())
    ) {
      this.logger.debug(
        'Skipping FilesModule lifecycle bootstrap on non-worker API replica',
      );
      return;
    }

    this.logger.log(
      'Initializing FilesModule physical storage lifecycle & maintenance...',
    );

    await this.initializeBucketLifecycle();
    await this.scheduleMaintenanceJobs();
  }

  async initializeBucketLifecycle(
    config?: StorageLifecycleConfiguration,
  ): Promise<void> {
    try {
      await this.blobService.applyLifecycleRules(config);
      this.logger.log('Storage bucket lifecycle rules configured successfully');
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to initialize bucket lifecycle rules: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async scheduleMaintenanceJobs(): Promise<void> {
    if (!this.queue) {
      this.logger.debug(
        'Files maintenance queue not available, skipping repeatable job registration',
      );
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
        id: 'files-repeat-multipart-cleanup',
        pattern: '0 */6 * * *',
        name: FILES_JOB_CLEANUP_EXPIRED_SESSIONS,
      },
      {
        id: 'files-repeat-orphan-blob-gc',
        pattern: '0 4 * * *',
        name: FILES_JOB_RECLAIM_ORPHAN_BLOBS,
      },
    ];

    try {
      for (const schedule of schedules) {
        await queueWithScheduler.upsertJobScheduler?.(
          schedule.id,
          { pattern: schedule.pattern },
          {
            name: schedule.name,
            opts: {
              removeOnComplete: 100,
              removeOnFail: 200,
            },
          },
        );
      }
      this.logger.log(
        'FilesModule maintenance jobs registered in BullMQ (Multipart Cleanup 6h, Orphan Blob GC daily)',
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to schedule FilesModule maintenance jobs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
