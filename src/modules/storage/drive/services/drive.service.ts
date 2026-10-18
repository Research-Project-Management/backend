import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import {
  STORAGE_NODE_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
  STORAGE_VERSION_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import {
  IStorageNodeRepository,
  ListDriveFilter,
  StorageNodeMapper,
} from '../repositories/prisma-node.repository';
import { IStorageVersionRepository } from '../repositories/prisma-version.repository';
import { IStorageQuotaRepository } from '../repositories/prisma-quota.repository';
import { StorageRedisCacheService, BlobService } from '@/modules/storage/core';
import { StorageNode, FileScope, FileTrashedEvent } from '../types';

@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);

  constructor(
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    private readonly cache: StorageRedisCacheService,
  ) {}

  async list(
    filter: ListDriveFilter,
  ): Promise<{ nodes: StorageNode[]; total: number }> {
    const scopeKey =
      filter.projectId ?? filter.userId ?? filter.authorId ?? 'default';

    const isFilterActive =
      filter.trashedOnly ||
      filter.starredOnly ||
      Boolean(filter.offset) ||
      Boolean(filter.search) ||
      Boolean(filter.types && filter.types.length > 0) ||
      Boolean(filter.sortBy);

    if (!isFilterActive) {
      const cached = await this.cache.wrapFolderListing<{ nodes: StorageNode[]; total: number }>(
        scopeKey,
        filter.parentId,
        () => this.nodeRepo.list(filter),
        120, // 2 minutes TTL
      );
      return {
        nodes: cached.nodes.map((n: StorageNode) =>
          n instanceof StorageNode ? n : new StorageNode(n),
        ),
        total: cached.total,
      };
    }

    const result = await this.nodeRepo.list(filter);

    if (!isFilterActive) {
      await this.cache.setFolderListing(
        scopeKey,
        filter.parentId,
        result,
        120,
      );
    }

    return result;
  }

  async getNodeById(nodeId: string): Promise<StorageNode> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found');
    }
    return node;
  }

  async getFolderPath(
    folderId?: string | null,
  ): Promise<Array<{ id: string; name: string }>> {
    if (!folderId || folderId === 'null') return [];
    if (typeof this.nodeRepo.getFolderPath === 'function') {
      const dbPath = await this.nodeRepo.getFolderPath(folderId);
      if (dbPath && dbPath.length > 0) return dbPath;
    }
    const path: Array<{ id: string; name: string }> = [];
    let currentId: string | null = folderId;
    let depth = 0;
    while (currentId && depth < 20) {
      const node = await this.nodeRepo.findById(currentId);
      if (!node) break;
      path.unshift({ id: node.id, name: node.name });
      currentId = node.parentId;
      depth++;
    }
    return path;
  }

  async createFolder(input: {
    userId: string;
    name: string;
    parentId?: string | null;
    projectId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<StorageNode> {
    const folder = new StorageNode({
      id: crypto.randomUUID(),
      projectId: input.projectId ?? null,
      name: input.name || 'New Folder',
      isFolder: true,
      size: 0n,
      parentId: input.parentId ?? null,
      authorId: input.userId,
      metadata: input.metadata ?? {},
    });
    const created = await this.nodeRepo.create(folder);
    const scopeKey = created.projectId ?? created.authorId;
    await this.cache.invalidateFolder(scopeKey, created.parentId);
    return created;
  }

  async createLogicalNode(input: {
    userId: string;
    name: string;
    size: bigint;
    mimeType: string;
    parentId?: string | null;
    projectId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<StorageNode> {
    const node = new StorageNode({
      id: crypto.randomUUID(),
      projectId: input.projectId ?? null,
      name: input.name,
      isFolder: false,
      size: input.size,
      mimeType: input.mimeType,
      parentId: input.parentId ?? null,
      authorId: input.userId,
      metadata: input.metadata ?? {},
    });
    const created = await this.nodeRepo.create(node);
    const scopeKey = created.projectId ?? created.authorId;
    await this.cache.invalidateFolder(scopeKey, created.parentId);
    return created;
  }

  async rename(nodeId: string, newName: string): Promise<StorageNode> {
    if (!newName) throw new NotFoundException('New name is required');
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('Node not found');
    }
    node.rename(newName);
    const updated = await this.nodeRepo.update(node);
    const scopeKey = updated.projectId ?? updated.authorId;
    await this.cache.invalidateFolder(scopeKey, updated.parentId);
    return updated;
  }

  async toggleStar(nodeId: string): Promise<StorageNode> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('Node not found');
    }
    node.toggleStar();
    const updated = await this.nodeRepo.update(node);
    const scopeKey = updated.projectId ?? updated.authorId;
    await this.cache.invalidateFolder(scopeKey, updated.parentId);
    return updated;
  }

  async setStarred(nodeId: string, starred: boolean): Promise<StorageNode | null> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) return null;
    if (node.starred !== starred) {
      node.toggleStar();
      const updated = await this.nodeRepo.update(node);
      const scopeKey = updated.projectId ?? updated.authorId;
      await this.cache.invalidateFolder(scopeKey, updated.parentId);
      return updated;
    }
    return node;
  }

  async updateMetadata(
    nodeId: string,
    metaData?: Record<string, unknown>,
    description?: string,
  ): Promise<StorageNode> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('Node not found');
    }
    const currentMeta = node.metadata || {};
    const updatedMeta: Record<string, unknown> = {
      ...currentMeta,
      ...(metaData || {}),
      ...(description !== undefined ? { description } : {}),
    };
    node.updateMetadata(updatedMeta);
    await this.nodeRepo.update(node);
    return node;
  }

  async linkScope(
    nodeId: string,
    linkedToType: FileScope | string,
    linkedToId?: string,
  ): Promise<void> {
    const node = await this.nodeRepo.findById(nodeId);
    if (node) {
      node.setScope(linkedToType as FileScope, linkedToId);
      await this.nodeRepo.update(node);
    }
  }

  async listSharedWithUser(
    userId: string,
    take: number,
    skip: number,
  ): Promise<{
    items: Array<{
      node: StorageNode;
      permission: string;
      sharedAt: Date;
    }>;
    total: number;
  }> {
    if (this.nodeRepo.listSharedWithUser) {
      return this.nodeRepo.listSharedWithUser(userId, take, skip);
    }
    return { items: [], total: 0 };
  }

  async shareNode(
    fileId: string,
    targetUserId: string,
    permissionType?: 'view' | 'edit',
  ) {
    const node = await this.nodeRepo.findById(fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found');
    }
    if (!this.nodeRepo.shareNode) {
      throw new NotFoundException(
        'Storage sharing repository service unavailable',
      );
    }
    return this.nodeRepo.shareNode(
      fileId,
      targetUserId,
      permissionType === 'edit' ? 'edit' : 'view',
    );
  }

  async move(nodeId: string, newParentId: string | null): Promise<StorageNode> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('Node not found');
    }

    if (newParentId) {
      if (nodeId === newParentId) {
        throw new BadRequestException('A folder cannot be moved into itself');
      }

      const targetParent = await this.nodeRepo.findById(newParentId);
      if (!targetParent || targetParent.isTrashed()) {
        throw new NotFoundException('Destination folder not found');
      }

      if (!targetParent.isFolder) {
        throw new BadRequestException('Destination must be a folder');
      }

      // Fast CTE Cycle prevention
      if (this.nodeRepo.isDescendant) {
        const isChild = await this.nodeRepo.isDescendant(nodeId, newParentId);
        if (isChild) {
          throw new BadRequestException(
            'Cannot move a directory inside its own subtree',
          );
        }
      } else {
        let curr: StorageNode | null = targetParent;
        while (curr && curr.parentId) {
          if (curr.parentId === nodeId) {
            throw new BadRequestException(
              'Cannot move a directory inside its own subtree',
            );
          }
          curr = await this.nodeRepo.findById(curr.parentId);
        }
      }
    }

    const oldParentId = node.parentId;
    node.moveTo(newParentId);
    const updated = await this.nodeRepo.update(node);

    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, oldParentId);
    await this.cache.invalidateFolder(scopeKey, newParentId);

    return updated;
  }

  async batchMove(
    ids: string[],
    targetFolderId: string | null,
  ): Promise<number> {
    let count = 0;
    for (const id of ids) {
      try {
        await this.move(id, targetFolderId);
        count++;
      } catch (err: unknown) {
        this.logger.debug(`batchMove skipped ${id}: ${(err as Error)?.message}`);
      }
    }
    return count;
  }

  async batchStar(ids: string[], starred: boolean): Promise<number> {
    let count = 0;
    for (const id of ids) {
      try {
        const updated = await this.setStarred(id, starred);
        if (updated) count++;
      } catch (err: unknown) {
        this.logger.debug(`batchStar skipped ${id}: ${(err as Error)?.message}`);
      }
    }
    return count;
  }
}

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

@Injectable()
export class QuotaService {
  constructor(
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
  ) {}

  async check(userId?: string | null, projectId?: string | null) {
    const quota = await this.quotaRepo.findByScope(userId, projectId);
    const DEFAULT_LIMIT = 5n * 1024n * 1024n * 1024n; // 5 GB
    const usedBytes = quota ? quota.usedBytes : 0n;
    const maxBytes = quota ? quota.maxBytes : DEFAULT_LIMIT;

    return {
      usedBytes: Number(usedBytes),
      maxBytes: Number(maxBytes),
      percentage: Number((usedBytes * 10000n) / maxBytes) / 100,
    };
  }
}

