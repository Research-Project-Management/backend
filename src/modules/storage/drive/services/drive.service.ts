import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { STORAGE_NODE_REPOSITORY } from '@/modules/storage/storage.tokens';
import {
  IStorageNodeRepository,
  ListDriveFilter,
} from '../repositories/prisma-node.repository';
import { StorageRedisCacheService } from '@/modules/storage/core';
import { StorageNode, FileScope } from '../types';

@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);

  constructor(
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    private readonly cache: StorageRedisCacheService,
  ) {}

  private async getActiveNodeOrThrow(
    nodeId: string,
    notFoundMessage = 'Node not found',
  ): Promise<StorageNode> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException(notFoundMessage);
    }
    return node;
  }

  private async invalidateNodeFolderCache(node: StorageNode): Promise<void> {
    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);
  }

  async list(
    filter: ListDriveFilter,
  ): Promise<{ nodes: StorageNode[]; total: number }> {
    const scopeKey =
      filter.projectId ?? filter.userId ?? filter.authorId ?? 'default';

    const isNonDefaultLimit =
      filter.limit !== undefined && filter.limit !== 100;
    const isFilterActive =
      filter.trashedOnly ||
      filter.starredOnly ||
      Boolean(filter.offset) ||
      isNonDefaultLimit ||
      Boolean(filter.search) ||
      Boolean(filter.types && filter.types.length > 0) ||
      Boolean(filter.sortBy);

    if (!isFilterActive) {
      const cached = await this.cache.wrapFolderListing<{
        nodes: StorageNode[];
        total: number;
      }>(
        scopeKey,
        filter.parentId,
        () => this.nodeRepo.list(filter),
        120, // 2 minutes TTL
      );
      return {
        nodes: cached.nodes.map((n: unknown) => StorageNode.fromSerialized(n)),
        total: cached.total,
      };
    }

    return this.nodeRepo.list(filter);
  }

  async getNodeById(nodeId: string): Promise<StorageNode> {
    return this.getActiveNodeOrThrow(nodeId, 'File not found');
  }

  async getFolderPath(
    folderId?: string | null,
  ): Promise<Array<{ id: string; name: string }>> {
    if (!folderId || folderId === 'null') return [];
    return this.nodeRepo.getFolderPath(folderId);
  }

  async createFolder(input: {
    userId: string;
    name: string;
    parentId?: string | null;
    projectId?: string | null;
    linkedToId?: string | null;
    scope?: FileScope | string;
    metadata?: Record<string, unknown>;
  }): Promise<StorageNode> {
    const folder = new StorageNode({
      id: crypto.randomUUID(),
      projectId: input.projectId ?? null,
      linkedToId: input.linkedToId ?? input.projectId ?? null,
      scope: input.scope,
      name: input.name || 'New Folder',
      isFolder: true,
      size: 0n,
      parentId: input.parentId ?? null,
      authorId: input.userId,
      metadata: input.metadata ?? {},
    });
    const created = await this.nodeRepo.create(folder);
    await this.invalidateNodeFolderCache(created);
    return created;
  }

  async createLogicalNode(input: {
    userId: string;
    name: string;
    size: bigint;
    mimeType: string;
    parentId?: string | null;
    projectId?: string | null;
    linkedToId?: string | null;
    scope?: FileScope | string;
    metadata?: Record<string, unknown>;
  }): Promise<StorageNode> {
    const node = new StorageNode({
      id: crypto.randomUUID(),
      projectId: input.projectId ?? null,
      linkedToId: input.linkedToId ?? input.projectId ?? null,
      scope: input.scope,
      name: input.name,
      isFolder: false,
      size: input.size,
      mimeType: input.mimeType,
      parentId: input.parentId ?? null,
      authorId: input.userId,
      metadata: input.metadata ?? {},
    });
    const created = await this.nodeRepo.create(node);
    await this.invalidateNodeFolderCache(created);
    return created;
  }

  async rename(nodeId: string, newName: string): Promise<StorageNode> {
    if (!newName) throw new BadRequestException('New name is required');
    const node = await this.getActiveNodeOrThrow(nodeId);
    node.rename(newName);
    const updated = await this.nodeRepo.update(node);
    await this.invalidateNodeFolderCache(updated);
    return updated;
  }

  async toggleStar(nodeId: string): Promise<StorageNode> {
    const node = await this.getActiveNodeOrThrow(nodeId);
    node.toggleStar();
    const updated = await this.nodeRepo.update(node);
    await this.invalidateNodeFolderCache(updated);
    return updated;
  }

  async setStarred(
    nodeId: string,
    starred: boolean,
  ): Promise<StorageNode | null> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) return null;
    if (node.starred !== starred) {
      node.toggleStar();
      const updated = await this.nodeRepo.update(node);
      await this.invalidateNodeFolderCache(updated);
      return updated;
    }
    return node;
  }

  async updateMetadata(
    nodeId: string,
    metaData?: Record<string, unknown>,
    description?: string,
  ): Promise<StorageNode> {
    const node = await this.getActiveNodeOrThrow(nodeId);
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
      node.setScope(linkedToType, linkedToId);
      const updated = await this.nodeRepo.update(node);
      await this.invalidateNodeFolderCache(updated);
    }
  }

  async listSharedWithUser(
    userId: string,
    take: number,
    skip: number,
    filter?: {
      search?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      types?: string[];
    },
  ): Promise<{
    items: Array<{
      node: StorageNode;
      permission: string;
      sharedAt: Date;
    }>;
    total: number;
  }> {
    return this.nodeRepo.listSharedWithUser(userId, take, skip, filter);
  }

  async shareNode(
    fileId: string,
    targetUserId: string,
    permissionType?: 'view' | 'edit',
  ) {
    await this.getActiveNodeOrThrow(fileId, 'File not found');
    return this.nodeRepo.shareNode(
      fileId,
      targetUserId,
      permissionType === 'edit' ? 'edit' : 'view',
    );
  }

  async move(nodeId: string, newParentId: string | null): Promise<StorageNode> {
    const node = await this.getActiveNodeOrThrow(nodeId);

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

      if (
        node.scope !== targetParent.scope ||
        (node.projectId ?? null) !== (targetParent.projectId ?? null)
      ) {
        throw new BadRequestException(
          'Cannot move a file or folder across different storage scopes or projects',
        );
      }

      const isChild = await this.nodeRepo.isDescendant(nodeId, newParentId);
      if (isChild) {
        throw new BadRequestException(
          'Cannot move a directory inside its own subtree',
        );
      }
    }

    const oldParentId = node.parentId;
    node.moveTo(newParentId);
    const updated = await this.nodeRepo.update(node);

    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, oldParentId);
    await this.cache.invalidateFolder(scopeKey, newParentId);
    if (typeof this.cache.invalidateScopeTree === 'function') {
      await this.cache.invalidateScopeTree(scopeKey);
    }

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
        this.logger.debug(
          `batchMove skipped ${id}: ${(err as Error)?.message}`,
        );
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
        this.logger.debug(
          `batchStar skipped ${id}: ${(err as Error)?.message}`,
        );
      }
    }
    return count;
  }
}
export { TrashService } from './trash.service';
