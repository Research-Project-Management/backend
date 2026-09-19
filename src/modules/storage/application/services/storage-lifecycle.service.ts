import {
  Injectable,
  Logger,
  Inject,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { STORAGE_DRIVER } from '../../storage.tokens';
import {
  IStorageDriver,
  StorageLifecycleConfiguration,
} from '../../domain/ports/storage-driver.port';
import { StorageQueueProducer } from '../queues/storage-queue.producer';
import {
  TrashRetentionJob,
  TrashPurgeResult,
} from '../jobs/trash-retention.cron';
import { MultipartCleanupJob } from '../jobs/multipart-cleanup.cron';
import { OrphanBlobJob } from '../jobs/orphan-blob.cron';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class StorageLifecycleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageLifecycleService.name);

  constructor(
    @Inject(STORAGE_DRIVER)
    private readonly driver: IStorageDriver,
    private readonly queueProducer: StorageQueueProducer,
    private readonly trashRetentionJob: TrashRetentionJob,
    private readonly multipartCleanupJob: MultipartCleanupJob,
    private readonly orphanBlobJob: OrphanBlobJob,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log(
      'Initializing Storage Lifecycle & Maintenance subsystem...',
    );

    // 1. Apply bucket-level lifecycle rules (S3 / Tigris standard)
    await this.initializeBucketLifecycle();

    // 2. Register BullMQ repeatable maintenance jobs (Trash retention, Multipart cleanup, Orphan GC)
    await this.queueProducer.scheduleMaintenanceJobs();
  }

  async initializeBucketLifecycle(): Promise<void> {
    if (!this.driver.applyLifecycleRules) {
      this.logger.debug(
        'Storage driver does not support lifecycle rules, skipping',
      );
      return;
    }

    try {
      const configPath = path.resolve(
        __dirname,
        '../../infrastructure/config/storage-lifecycle-rules.json',
      );
      let config: StorageLifecycleConfiguration | undefined;

      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(raw) as StorageLifecycleConfiguration;
      }

      await this.driver.applyLifecycleRules(config);
      this.logger.log(
        'Bucket lifecycle configuration initialized successfully',
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to initialize bucket lifecycle rules: ${err?.message}`,
      );
    }
  }

  async getLifecycleRules(): Promise<StorageLifecycleConfiguration | null> {
    if (this.driver.getLifecycleRules) {
      return this.driver.getLifecycleRules();
    }
    return null;
  }

  async applyCustomLifecycleRules(
    config: StorageLifecycleConfiguration,
  ): Promise<void> {
    if (this.driver.applyLifecycleRules) {
      await this.driver.applyLifecycleRules(config);
    }
  }

  async runTrashPurge(retentionDays = 30): Promise<TrashPurgeResult> {
    return this.trashRetentionJob.processExpiredTrash(retentionDays);
  }

  async runMultipartCleanup(): Promise<number> {
    return this.multipartCleanupJob.processExpiredSessions();
  }

  async runOrphanBlobSweep(): Promise<number> {
    return this.orphanBlobJob.processTombstonedBlobs();
  }
}
