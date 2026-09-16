import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import {
  STORAGE_NODE_REPOSITORY,
  STORAGE_BLOB_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
} from '../../storage.tokens';
import { IStorageNodeRepository } from '../../domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '../../domain/ports/storage-blob.repository.port';
import { IStorageQuotaRepository } from '../../domain/ports/storage-quota.repository.port';
import { StorageRedisCacheService } from '../../infrastructure/cache/storage-redis-cache.service';
import { StorageNode } from '../../domain/entities/storage-node.entity';

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
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
    @Optional()
    private readonly cache?: StorageRedisCacheService,
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
          const subtree = this.nodeRepo.findSubtreeNodes
            ? await this.nodeRepo.findSubtreeNodes(node.id)
            : [node];
          // Delete children first, then parent folder
          const sortedSubtree = [...subtree].sort((a, b) => {
            if (a.isFolder && !b.isFolder) return 1;
            if (!a.isFolder && b.isFolder) return -1;
            return 0;
          });

          for (const subnode of sortedSubtree) {
            if (processedIds.has(subnode.id)) continue;
            await this.purgeSingleNode(subnode);
            processedIds.add(subnode.id);
            purgedCount++;
            if (subnode.blobId) {
              reclaimedBytes += BigInt(subnode.size);
            }
          }
        } else {
          await this.purgeSingleNode(node);
          processedIds.add(node.id);
          purgedCount++;
          if (node.blobId) {
            reclaimedBytes += BigInt(node.size);
          }
        }
      } catch (err: any) {
        errors++;
        this.logger.error(
          `Failed to purge expired trash node ${node.id}: ${err.message}`,
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

  private async purgeSingleNode(node: StorageNode): Promise<void> {
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

    if (this.cache) {
      const scopeKey = node.projectId ?? node.authorId;
      await this.cache.invalidateFolder(scopeKey, node.parentId);
    }
  }
}
