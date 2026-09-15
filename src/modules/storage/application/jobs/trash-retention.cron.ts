import { Injectable, Logger, Inject } from '@nestjs/common';
import {
  STORAGE_NODE_REPOSITORY,
  STORAGE_BLOB_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
} from '../../storage.tokens';
import { IStorageNodeRepository } from '../../domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '../../domain/ports/storage-blob.repository.port';
import { IStorageQuotaRepository } from '../../domain/ports/storage-quota.repository.port';

@Injectable()
export class TrashRetentionJob {
  private readonly logger = new Logger(TrashRetentionJob.name);

  constructor(
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
  ) {}

  async processExpiredTrash(retentionDays = 30): Promise<number> {
    const expiredNodes = await this.nodeRepo.findExpiredTrash(
      retentionDays,
      500,
    );
    let purgedCount = 0;

    for (const node of expiredNodes) {
      try {
        if (node.blobId) {
          const blob = await this.blobRepo.findById(node.blobId);
          if (blob) {
            blob.decrementRef();
            await this.blobRepo.update(blob);
          }
          await this.quotaRepo.decrementUsage(
            node.authorId,
            node.projectId,
            node.size,
          );
        }
        await this.nodeRepo.delete(node.id);
        purgedCount++;
      } catch (err: any) {
        this.logger.error(
          `Failed to purge expired trash node ${node.id}: ${err.message}`,
        );
      }
    }

    if (purgedCount > 0) {
      this.logger.log(
        `TrashRetentionJob purged ${purgedCount} expired items (older than ${retentionDays} days)`,
      );
    }
    return purgedCount;
  }
}
