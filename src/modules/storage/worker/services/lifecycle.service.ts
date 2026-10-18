import {
  Injectable,
  Logger,
  Inject,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import {
  STORAGE_NODE_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
  STORAGE_VERSION_REPOSITORY,
  UPLOAD_SESSION_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import {
  IStorageNodeRepository,
  IStorageQuotaRepository,
  IStorageVersionRepository,
  StorageNode,
} from '@/modules/storage/drive';
import { IUploadSessionRepository } from '@/modules/storage/transfer';
import {
  BlobService,
  StorageRedisCacheService,
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
    private readonly blobService: BlobService,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
    @Optional()
    private readonly cache?: StorageRedisCacheService,
    @Optional()
    @Inject(STORAGE_VERSION_REPOSITORY)
    private readonly versionRepo?: IStorageVersionRepository,
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
        if (node.isFolder) {
          // Cascading subtree purge for folder and all children
          const subtree = await this.nodeRepo.findSubtreeNodes(node.id);
          const sortedSubtree = StorageNode.sortBottomUp(subtree);

          for (const subnode of sortedSubtree) {
            if (processedIds.has(subnode.id)) continue;
            const nodeReclaimed = await this.purgeSingleNode(subnode);
            processedIds.add(subnode.id);
            purgedCount++;
            reclaimedBytes += nodeReclaimed;
          }
        } else {
          const nodeReclaimed = await this.purgeSingleNode(node);
          processedIds.add(node.id);
          purgedCount++;
          reclaimedBytes += nodeReclaimed;
        }
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

  private async purgeSingleNode(node: StorageNode): Promise<bigint> {
    let reclaimed = 0n;
    const versions =
      this.versionRepo && !node.isFolder
        ? await this.versionRepo.findByFileId(node.id)
        : [];

    if (versions.length > 0 && this.versionRepo) {
      for (const v of versions) {
        await this.blobService.releaseBlob(v.blobId);
        await this.quotaRepo.decrementUsage(
          node.authorId,
          node.projectId,
          v.sizeBytes,
        );
        reclaimed += BigInt(v.sizeBytes);
      }
      await this.versionRepo.deleteByFileId(node.id);
    } else if (node.blobId) {
      await this.blobService.releaseBlob(node.blobId);
      await this.quotaRepo.decrementUsage(
        node.authorId,
        node.projectId,
        node.size,
      );
      reclaimed += BigInt(node.size);
    }

    await this.nodeRepo.delete(node.id);

    if (this.cache) {
      const scopeKey = node.projectId ?? node.authorId;
      await this.cache.invalidateFolder(scopeKey, node.parentId);
    }
    return reclaimed;
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
export class OrphanBlobJob {
  private readonly logger = new Logger(OrphanBlobJob.name);

  constructor(private readonly blobService: BlobService) {}

  async processTombstonedBlobs(): Promise<number> {
    const deletedCount = await this.blobService.reclaimOrphanBlobs(100);
    if (deletedCount > 0) {
      this.logger.log(
        `OrphanBlobJob reclaimed ${deletedCount} unused physical blobs from S3 storage`,
      );
    }
    return deletedCount;
  }
}

@Injectable()
export class StorageLifecycleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageLifecycleService.name);

  constructor(
    private readonly blobService: BlobService,
    private readonly queueProducer: StorageQueueProducer,
    private readonly trashRetentionJob: TrashRetentionJob,
    private readonly multipartCleanupJob: MultipartCleanupJob,
    private readonly orphanBlobJob: OrphanBlobJob,
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

  async getLifecycleRules(): Promise<StorageLifecycleConfiguration | null> {
    return this.blobService.getLifecycleRules();
  }

  async applyCustomLifecycleRules(
    config: StorageLifecycleConfiguration,
  ): Promise<void> {
    await this.blobService.applyLifecycleRules(config);
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
