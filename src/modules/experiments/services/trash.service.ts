import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FILES_PORT, type IFilesPort } from '@/modules/files';
import {
  EXPERIMENT_NODE_REPOSITORY,
  EXPERIMENT_VERSION_REPOSITORY,
} from '../experiments.constant';
import { INodeRepository } from '../repositories/node.repository';
import { IVersionRepository } from '../repositories/version.repository';
import { ExperimentNode } from '../domain/node.domain';
import { FileTrashedEvent } from '../domain/experiments.event';
import { ExperimentsCacheService } from './cache.service';

@Injectable()
export class TrashService {
  private readonly logger = new Logger(TrashService.name);

  constructor(
    @Inject(EXPERIMENT_NODE_REPOSITORY)
    private readonly nodeRepo: INodeRepository,
    @Inject(FILES_PORT)
    private readonly filesPort: IFilesPort,
    private readonly cache: ExperimentsCacheService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(EXPERIMENT_VERSION_REPOSITORY)
    private readonly versionRepo: IVersionRepository,
  ) {}

  async softDelete(nodeId: string): Promise<number> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node) {
      throw new NotFoundException('Node not found');
    }

    const affectedCount = await this.nodeRepo.softDeleteSubtree(nodeId);
    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);
    if (typeof this.cache.invalidateScopeTree === 'function') {
      await this.cache.invalidateScopeTree(scopeKey);
    }
    await Promise.resolve(this.cache?.invalidateStreamNodeMeta?.(nodeId)).catch(
      () => {},
    );

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

    if (node.parentId) {
      const parent = await this.nodeRepo.findById(node.parentId);
      if (!parent || parent.isTrashed()) {
        node.moveTo(null);
        await this.nodeRepo.update(node);
      }
    }

    const restoredCount = await this.nodeRepo.restoreSubtree(nodeId);
    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);
    if (typeof this.cache.invalidateScopeTree === 'function') {
      await this.cache.invalidateScopeTree(scopeKey);
    }
    return restoredCount;
  }

  async purgeNodeAndSubtree(
    node: ExperimentNode,
    processedIds?: Set<string>,
  ): Promise<{ purgedCount: number; reclaimedBytes: bigint }> {
    let purgedCount = 0;
    let reclaimedBytes = 0n;

    const purgeSingle = async (target: ExperimentNode): Promise<bigint> => {
      let reclaimed = 0n;
      const targetSpaceId = target.projectId ?? target.authorId;
      if (this.versionRepo && !target.isFolder) {
        const versions = await this.versionRepo.findByFileId(target.id);
        if (versions.length > 0) {
          for (const v of versions) {
            await this.filesPort.releaseBlob(v.blobId);
            await this.filesPort.releaseQuota(targetSpaceId, v.sizeBytes);
            reclaimed += BigInt(v.sizeBytes);
          }
          await this.versionRepo.deleteByFileId(target.id);
          await this.nodeRepo.delete(target.id);
          await Promise.resolve(
            this.cache?.invalidateStreamNodeMeta?.(target.id),
          ).catch(() => {});
          return reclaimed;
        }
      }
      if (target.blobId) {
        await this.filesPort.releaseBlob(target.blobId);
        await this.filesPort.releaseQuota(targetSpaceId, target.size);
        reclaimed += BigInt(target.size);
      }
      await this.nodeRepo.delete(target.id);
      await Promise.resolve(
        this.cache?.invalidateStreamNodeMeta?.(target.id),
      ).catch(() => {});
      return reclaimed;
    };

    if (node.isFolder) {
      const subtree = await this.nodeRepo.findSubtreeNodes(node.id);
      const sortedSubtree = ExperimentNode.sortBottomUp(subtree);

      for (const subnode of sortedSubtree) {
        if (processedIds?.has(subnode.id)) continue;
        const reclaimed = await purgeSingle(subnode);
        processedIds?.add(subnode.id);
        purgedCount++;
        reclaimedBytes += reclaimed;
      }
    } else {
      if (!processedIds?.has(node.id)) {
        const reclaimed = await purgeSingle(node);
        processedIds?.add(node.id);
        purgedCount++;
        reclaimedBytes += reclaimed;
      }
    }

    if (this.cache) {
      const scopeKey = node.projectId ?? node.authorId;
      await this.cache.invalidateFolder(scopeKey, node.parentId);
      await Promise.resolve(
        this.cache.invalidateStreamNodeMeta?.(node.id),
      ).catch(() => {});
    }

    return { purgedCount, reclaimedBytes };
  }

  async permanentDelete(nodeId: string): Promise<void> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node) {
      throw new NotFoundException('Node not found');
    }

    await this.purgeNodeAndSubtree(node);
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
            new FileTrashedEvent(
              node.id,
              node.authorId,
              new Date(),
              node.projectId,
            ),
          );
          count++;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `batchSoftDelete failed for node ${id}: ${(err as Error)?.message}`,
        );
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
        this.logger.warn(
          `batchRestore failed for node ${id}: ${(err as Error)?.message}`,
        );
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
        this.logger.warn(
          `batchPermanentDelete failed for node ${id}: ${(err as Error)?.message}`,
        );
      }
    }
    return count;
  }
}
