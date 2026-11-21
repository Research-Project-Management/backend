import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Inject,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { shouldRunWorkerConsumers } from '@/core';
import {
  FILES_JOB_CLEANUP_EXPIRED_SESSIONS,
  FILES_JOB_RECLAIM_ORPHAN_BLOBS,
  FILES_JOB_RECONCILE_QUOTAS,
  FILES_JOB_RECOVER_STALE_FINALIZING,
  FILES_JOB_SWEEP_STAGING_BLOBS,
  FILES_MAINTENANCE_QUEUE,
  STORAGE_ADAPTER,
} from '../files.constant';
import { QuotaRepository } from '../repositories/quota.repository';
import { BlobService } from '../services/blob.service';
import { FilesUploadService } from '../services/upload.service';
import {
  IStorageAdapter,
  StorageLifecycleConfiguration,
  supportsBucketLifecycle,
} from '../types/adapter.type';

/**
 * Unified BullMQ maintenance scheduler & consumer for FilesModule:
 * initializes bucket lifecycle rules, registers repeatable maintenance jobs,
 * and processes session cleanup, SKIP LOCKED orphan blob GC, and quota reconciliation.
 */
@Processor(FILES_MAINTENANCE_QUEUE, { concurrency: 1 })
export class FilesMaintenanceProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(FilesMaintenanceProcessor.name);

  constructor(
    @Inject(STORAGE_ADAPTER) private readonly driver: IStorageAdapter,
    private readonly blobService: BlobService,
    private readonly uploadService: FilesUploadService,
    @Optional() private readonly quotaRepo?: QuotaRepository,
    @Optional()
    @InjectQueue(FILES_MAINTENANCE_QUEUE)
    private readonly queue?: Queue,
  ) {
    super();
    if (this.queue && typeof this.queue.on === 'function') {
      this.queue.on('error', (err: Error) => {
        this.logger.warn(
          `Files maintenance queue connection notice: ${err?.message || err}`,
        );
      });
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(
          `Files maintenance worker connection notice: ${err.message}`,
        );
      });
    } catch (err: unknown) {
      this.logger.debug(
        `Files maintenance worker listener initialization skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

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
      if (!supportsBucketLifecycle(this.driver)) {
        this.logger.debug(
          'Storage adapter has no bucket lifecycle capability; skipping lifecycle rules',
        );
        return;
      }
      await this.driver.applyLifecycleRules(config);
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
        pattern: '0 */2 * * *',
        name: FILES_JOB_RECLAIM_ORPHAN_BLOBS,
      },
      {
        id: 'files-repeat-quota-reconcile',
        pattern: '30 3 * * *',
        name: FILES_JOB_RECONCILE_QUOTAS,
      },
      {
        id: 'files-repeat-stale-finalizing-recovery',
        pattern: '*/5 * * * *',
        name: FILES_JOB_RECOVER_STALE_FINALIZING,
      },
      {
        id: 'files-repeat-sweep-staging-blobs',
        pattern: '*/10 * * * *',
        name: FILES_JOB_SWEEP_STAGING_BLOBS,
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
        'FilesModule maintenance jobs registered in BullMQ (Multipart Cleanup 6h, Orphan Blob GC 2h, Quota Reconcile daily)',
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to schedule FilesModule maintenance jobs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async process(job: Job<unknown>): Promise<number | null> {
    switch (job.name) {
      case FILES_JOB_CLEANUP_EXPIRED_SESSIONS: {
        this.logger.log(
          `Running FilesModule maintenance: Cleanup expired multipart sessions [${job.id}]`,
        );
        return this.uploadService.cleanupExpiredSessions(100);
      }
      case FILES_JOB_RECLAIM_ORPHAN_BLOBS: {
        this.logger.log(
          `Running FilesModule maintenance: Reclaim orphan CAS blobs [${job.id}]`,
        );
        return this.blobService.reclaimOrphanBlobs(200, {
          maxBatches: 5,
          timeBudgetMs: 45_000,
        });
      }
      case FILES_JOB_RECONCILE_QUOTAS: {
        this.logger.log(
          `Running FilesModule maintenance: Reconcile Space quotas [${job.id}]`,
        );
        return this.quotaRepo ? this.quotaRepo.reconcileSpaceQuotas(200) : 0;
      }
      case FILES_JOB_RECOVER_STALE_FINALIZING: {
        this.logger.log(
          `Running FilesModule maintenance: Recover stale FINALIZING upload sessions [${job.id}]`,
        );
        return this.uploadService.recoverStaleFinalizingSessions(100);
      }
      case FILES_JOB_SWEEP_STAGING_BLOBS: {
        this.logger.log(
          `Running FilesModule maintenance: Sweep unpromoted staging blobs [${job.id}]`,
        );
        return this.uploadService.sweepUnpromotedStagingBlobs(100);
      }
      default: {
        this.logger.warn(
          `Received unknown FilesModule maintenance job "${job.name}" [${job.id}]`,
        );
        return null;
      }
    }
  }
}
