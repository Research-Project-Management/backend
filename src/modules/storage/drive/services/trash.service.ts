import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  STORAGE_NODE_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
  STORAGE_VERSION_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import { IStorageNodeRepository } from '../repositories/prisma-node.repository';
import { IStorageVersionRepository } from '../repositories/prisma-version.repository';
import { IStorageQuotaRepository } from '../repositories/prisma-quota.repository';
import { StorageRedisCacheService, BlobService } from '@/modules/storage/core';
import { StorageNode, FileTrashedEvent } from '../types';

@Injectable()
export class TrashService {
  private readonly logger = new Logger(TrashService.name);

  constructor(
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    private readonly blobService: BlobService,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
    private readonly cache: StorageRedisCacheService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(STORAGE_VERSION_REPOSITORY)
    private readonly versionRepo: IStorageVersionRepository,
  ) {}

  async softDelete(nodeId: string): Promise<number> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node) {
      throw new NotFoundException('Node not found');
    }

    const affectedCount = await this.nodeRepo.softDeleteSubtree(nodeId);
    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);

    this.eventEmitter.emit(
      'file.trashed',
      new FileTrashedEvent(node.id, node.authorId, new Date(), node.projectId),
    );

    return affectedCount;
  }

  async restore(nodeId: string): Promise<number> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node) {
      throw new NotFoundException('Node not found');
    }

    const restoredCount = await this.nodeRepo.restoreSubtree(nodeId);
    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);
    return restoredCount;
  }

  private async releaseNodeBlobsAndQuota(target: StorageNode): Promise<void> {
    if (this.versionRepo && !target.isFolder) {
      const versions = await this.versionRepo.findByFileId(target.id);
      if (versions.length > 0) {
        for (const v of versions) {
          await this.blobService.releaseBlob(v.blobId);
          await this.quotaRepo.decrementUsage(
            target.authorId,
            target.projectId,
            v.sizeBytes,
          );
        }
        await this.versionRepo.deleteByFileId(target.id);
        return;
      }
    }
    if (target.blobId) {
      await this.blobService.releaseBlob(target.blobId);
      await this.quotaRepo.decrementUsage(
        target.authorId,
        target.projectId,
        target.size,
      );
    }
  }

  async permanentDelete(nodeId: string): Promise<void> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node) {
      throw new NotFoundException('Node not found');
    }

    if (node.isFolder) {
      // Cascading subtree purge for folder and all children
      const subtree = this.nodeRepo.findSubtreeNodes
        ? await this.nodeRepo.findSubtreeNodes(nodeId)
        : [node];
      const nodeById = new Map(subtree.map((n) => [n.id, n]));
      const getDepth = (n: StorageNode): number => {
        let d = 0;
        let curr: StorageNode | undefined = n;
        while (curr?.parentId && nodeById.has(curr.parentId) && d < 100) {
          d++;
          curr = nodeById.get(curr.parentId);
        }
        return d;
      };
      const sortedSubtree = [...subtree].sort((a, b) => {
        if (!a.isFolder && b.isFolder) return -1;
        if (a.isFolder && !b.isFolder) return 1;
        return getDepth(b) - getDepth(a);
      });

      for (const subnode of sortedSubtree) {
        await this.releaseNodeBlobsAndQuota(subnode);
        await this.nodeRepo.delete(subnode.id);
      }
    } else {
      await this.releaseNodeBlobsAndQuota(node);
      await this.nodeRepo.delete(nodeId);
    }

    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);
  }

  async batchSoftDelete(ids: string[]): Promise<number> {
    let count = 0;
    const parentIdsToInvalidate = new Set<string | null>();
    let scopeKey: string | null = null;

    for (const id of ids) {
      try {
        const node = await this.nodeRepo.findById(id);
        if (node && !node.isTrashed()) {
          await this.nodeRepo.softDeleteSubtree(id);
          parentIdsToInvalidate.add(node.parentId);
          if (!scopeKey) scopeKey = node.projectId ?? node.authorId;
          this.eventEmitter.emit(
            'file.trashed',
            new FileTrashedEvent(node.id, node.authorId, new Date(), node.projectId),
          );
          count++;
        }
      } catch (err: unknown) {
        this.logger.warn(`batchSoftDelete failed for node ${id}: ${(err as Error)?.message}`);
      }
    }

    if (scopeKey) {
      for (const parentId of parentIdsToInvalidate) {
        await this.cache.invalidateFolder(scopeKey, parentId);
      }
    }
    return count;
  }

  async batchRestore(ids: string[]): Promise<number> {
    let count = 0;
    const parentIdsToInvalidate = new Set<string | null>();
    let scopeKey: string | null = null;

    for (const id of ids) {
      try {
        const node = await this.nodeRepo.findById(id);
        if (node && node.isTrashed()) {
          await this.nodeRepo.restoreSubtree(id);
          parentIdsToInvalidate.add(node.parentId);
          if (!scopeKey) scopeKey = node.projectId ?? node.authorId;
          count++;
        }
      } catch (err: unknown) {
        this.logger.warn(`batchRestore failed for node ${id}: ${(err as Error)?.message}`);
      }
    }

    if (scopeKey) {
      for (const parentId of parentIdsToInvalidate) {
        await this.cache.invalidateFolder(scopeKey, parentId);
      }
    }
    return count;
  }

  async batchPermanentDelete(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      try {
        await this.permanentDelete(id);
        count++;
      } catch (err: unknown) {
        this.logger.warn(`batchPermanentDelete failed for node ${id}: ${(err as Error)?.message}`);
      }
    }
    return count;
  }
}
