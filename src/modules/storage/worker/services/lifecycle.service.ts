import {
  Injectable,
  Logger,
  Inject,
  OnApplicationBootstrap,
} from '@nestjs/common';
import {
  STORAGE_NODE_REPOSITORY,
  UPLOAD_SESSION_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import {
  IStorageNodeRepository,
  TrashService,
} from '@/modules/storage/drive';
import { IUploadSessionRepository } from '@/modules/storage/transfer';
import {
  BlobService,
  StorageLifecycleConfiguration,
} from '@/modules/storage/core';
import { StorageQueueProducer } from './queue.producer';
import { shouldRunWorkerConsumers } from '@/core';

export interface TrashPurgeResult {
  purgedCount: number;
  reclaimedBytes: bigint;
  errors: number;
}

@Injectable()
export class TrashRetentionJob {
  private readonly logger = new Logger(TrashRetentionJob.name);

  constructor(
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    private readonly trashService: TrashService,
  ) {}

  async processExpiredTrash(retentionDays = 30): Promise<TrashPurgeResult> {
    const expiredNodes = await this.nodeRepo.findExpiredTrash(
      retentionDays,
      500,
    );
    let purgedCount = 0;
    let reclaimedBytes = 0n;
    let errors = 0;

    const processedIds = new Set<string>();

    for (const node of expiredNodes) {
      if (processedIds.has(node.id)) continue;

      try {
        const result = await this.trashService.purgeNodeAndSubtree(
          node,
          processedIds,
        );
        purgedCount += result.purgedCount;
        reclaimedBytes += result.reclaimedBytes;
      } catch (err: unknown) {
        errors++;
        this.logger.error(
          `Failed to purge expired trash node ${node.id}: ${(err as Error)?.message}`,
        );
      }
    }

    if (purgedCount > 0) {
      this.logger.log(
        `TrashRetentionJob purged ${purgedCount} expired items (older than ${retentionDays} days), reclaimed ${reclaimedBytes} bytes of storage quota`,
      );
    }
    return { purgedCount, reclaimedBytes, errors };
  }
}

@Injectable()
export class MultipartCleanupJob {
  private readonly logger = new Logger(MultipartCleanupJob.name);

  constructor(
    private readonly blobService: BlobService,
    @Inject(UPLOAD_SESSION_REPOSITORY)
    private readonly sessionRepo: IUploadSessionRepository,
  ) {}

  async processExpiredSessions(): Promise<number> {
    const now = new Date();
    const expired = await this.sessionRepo.findExpiredSessions(now, 100);
    let abortedCount = 0;

    for (const session of expired) {
      try {
        await this.blobService.abortMultipartUpload(
          session.s3Key,
          session.s3UploadId,
        );
        session.markAborted();
        await this.sessionRepo.update(session);
        abortedCount++;
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to abort expired multipart session ${session.id}: ${(err as Error)?.message}`,
        );
      }
    }

    if (abortedCount > 0) {
      this.logger.log(
        `MultipartCleanupJob aborted ${abortedCount} abandoned multipart upload sessions`,
      );
    }
    return abortedCount;
  }
}

@Injectable()
export class StorageLifecycleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageLifecycleService.name);

  constructor(
    private readonly blobService: BlobService,
    private readonly queueProducer: StorageQueueProducer,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (
      process.env.STORAGE_BOOTSTRAP_LIFECYCLE === 'false' ||
      (process.env.NODE_ENV === 'production' && !shouldRunWorkerConsumers())
    ) {
      this.logger.debug(
        'Skipping Storage Lifecycle bootstrap on non-worker API replica',
      );
      return;
    }

    this.logger.log(
      'Initializing Storage Lifecycle & Maintenance subsystem...',
    );

    // 1. Apply bucket-level lifecycle rules (S3 / Tigris standard)
    await this.initializeBucketLifecycle();

    // 2. Register BullMQ repeatable maintenance jobs (Trash retention, Multipart cleanup, Orphan GC)
    await this.queueProducer.scheduleMaintenanceJobs();
  }

  async initializeBucketLifecycle(
    config?: StorageLifecycleConfiguration,
  ): Promise<void> {
    try {
      await this.blobService.applyLifecycleRules(config);
      this.logger.log(
        'Bucket lifecycle configuration initialized successfully',
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to initialize bucket lifecycle rules: ${(err as Error)?.message}`,
      );
    }
  }
}
