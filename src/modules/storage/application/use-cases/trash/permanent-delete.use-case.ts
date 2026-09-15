import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import {
  STORAGE_NODE_REPOSITORY,
  STORAGE_BLOB_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
} from '../../../storage.tokens';
import { IStorageNodeRepository } from '../../../domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '../../../domain/ports/storage-blob.repository.port';
import { IStorageQuotaRepository } from '../../../domain/ports/storage-quota.repository.port';
import { StorageRedisCacheService } from '../../../infrastructure/cache/storage-redis-cache.service';

@Injectable()
export class PermanentDeleteUseCase {
  constructor(
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
    private readonly cache: StorageRedisCacheService,
  ) {}

  async execute(nodeId: string): Promise<void> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node) {
      throw new NotFoundException('Node not found');
    }

    // 1. If linked to physical blob, decrement reference count
    if (node.blobId) {
      const blob = await this.blobRepo.findById(node.blobId);
      if (blob) {
        blob.decrementRef();
        await this.blobRepo.update(blob);
      }
      // Release quota
      await this.quotaRepo.decrementUsage(
        node.authorId,
        node.projectId,
        node.size,
      );
    }

    // 2. Hard delete node
    await this.nodeRepo.delete(nodeId);
    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);
  }
}
