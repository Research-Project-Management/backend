import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { CollectionsRepository } from './collections.repository';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
  ReorderItemDto,
  AssignItemsToCollectionDto,
} from './dto/collections.dto';
import {
  CollectionRecord,
  CollectionView,
  CollectionNode,
  CollectionDeleteStrategy,
  CollectionMoveResult,
} from './types/collections.types';

import {
  buildCollectionTree,
  detectCollectionCycle,
} from './utils/collections.util';

export type FormattedCollection<
  T extends {
    id: string;
    parentId?: string | null;
    _count?: { catalogItems?: number } | null;
  },
> = T & {
  parent?: string | null;
  itemsCount: number;
};

@Injectable()
export class CollectionsService {
  constructor(private readonly collectionRepo: CollectionsRepository) {}

  private async resolveWorkspaceId(workspaceId: string): Promise<string> {
    if (typeof (this.collectionRepo as any).resolveWorkspaceId === 'function') {
      return (this.collectionRepo as any).resolveWorkspaceId(workspaceId);
    }
    const ws = await this.collectionRepo.resolveWorkspace(workspaceId);
    return ws?.id || workspaceId;
  }

  private formatCollection(record: CollectionRecord): CollectionView;
  private formatCollection(record: null | undefined): null;
  private formatCollection(
    record: CollectionRecord | null | undefined,
  ): CollectionView | null;
  private formatCollection(
    record: CollectionRecord | null | undefined,
  ): CollectionView | null {
    if (!record) return null;
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      color: record.color,
      icon: record.icon,
      parentId: record.parentId,
      parent: record.parentId,
      workspaceId: record.workspaceId,
      createdById: record.createdById,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      itemsCount: record._count?.catalogItems ?? 0,
    };
  }

  async getCollections(
    workspaceId: string,
  ): Promise<{ collections: CollectionView[] }> {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);
    const collections =
      await this.collectionRepo.findWorkspaceCollections(targetWsId);

    return {
      collections: collections.map((c) => this.formatCollection(c)),
    };
  }

  async getCollectionTree(
    workspaceId: string,
  ): Promise<{ tree: CollectionNode[] }> {
    const { collections } = await this.getCollections(workspaceId);
    return {
      tree: buildCollectionTree(collections),
    };
  }

  async getCollectionById(
    workspaceId: string,
    collectionId: string,
  ): Promise<{ collection: CollectionView }> {
    const collection = await this.getCollectionInWorkspace(
      workspaceId,
      collectionId,
    );

    return { collection: this.formatCollection(collection) };
  }

  async createCollection(
    workspaceId: string,
    userId: string,
    dto: CreateCollectionDto,
  ): Promise<{ collection: CollectionView }> {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);

    const parentId = dto.parentId || dto.parent || null;
    if (parentId) {
      const parent = await this.collectionRepo.findCollectionById(parentId);
      if (!parent || parent.workspaceId !== targetWsId) {
        throw new NotFoundException('Parent collection not found in workspace');
      }
    }

    const collection = await this.collectionRepo.createCollection({
      name: dto.name,
      description: dto.description || '',
      color: dto.color || '#3370ff',
      icon: dto.icon || '',
      parentId,
      workspaceId: targetWsId,
      createdById: userId,
    });

    return { collection: this.formatCollection(collection) };
  }

  async updateCollection(
    workspaceId: string,
    collectionId: string,
    dto: UpdateCollectionDto,
  ): Promise<{ collection: CollectionView }> {
    const existing = await this.getCollectionInWorkspace(
      workspaceId,
      collectionId,
    );

    const parentId =
      dto.parentId !== undefined
        ? dto.parentId
        : dto.parent !== undefined
          ? dto.parent
          : undefined;

    if (parentId !== undefined && parentId !== null) {
      if (parentId === collectionId) {
        throw new BadRequestException('A collection cannot be its own parent');
      }

      await this.assertCollectionParentInWorkspace(
        parentId,
        existing.workspaceId,
      );
      await this.validateNoCircularHierarchy(
        collectionId,
        parentId,
        existing.workspaceId,
      );
    }

    const collection = await this.collectionRepo.updateCollection(
      collectionId,
      {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(parentId !== undefined && { parentId: parentId || null }),
      },
    );

    return { collection: this.formatCollection(collection) };
  }

  /**
   * Prevents circular parent-child relationships (e.g., A -> B -> C -> A)
   */
  private async validateNoCircularHierarchy(
    collectionId: string,
    targetParentId: string,
    workspaceId: string,
  ): Promise<void> {
    const allCollections =
      await this.collectionRepo.findWorkspaceCollections(workspaceId);

    const check = detectCollectionCycle(
      collectionId,
      targetParentId,
      allCollections,
    );

    if (check.hasCycle) {
      const pathStr = check.cyclePath.join(' -> ');
      throw new BadRequestException(
        `Circular hierarchy detected: cannot set a collection as child of its own descendant (${pathStr})`,
      );
    }
  }

  async deleteCollection(
    workspaceId: string,
    collectionId: string,
    strategy: CollectionDeleteStrategy = 'cascade',
  ): Promise<{ message: string }> {
    const existing = await this.getCollectionInWorkspace(
      workspaceId,
      collectionId,
    );

    if (strategy === 'move-to-parent') {
      await this.collectionRepo.reparentChildren(
        collectionId,
        existing.parentId || null,
      );
    } else if (strategy === 'orphan') {
      await this.collectionRepo.reparentChildren(collectionId, null);
    }

    await this.collectionRepo.deleteCollection(collectionId);
    return { message: 'Collection deleted successfully' };
  }

  async moveItems(
    workspaceId: string,
    targetCollectionId: string | null,
    itemIds: string[],
  ): Promise<CollectionMoveResult> {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);

    const normalizedTargetId =
      targetCollectionId === 'unfiled' ||
      targetCollectionId === 'root' ||
      !targetCollectionId
        ? null
        : targetCollectionId;

    if (normalizedTargetId) {
      const targetCol =
        await this.collectionRepo.findCollectionById(normalizedTargetId);
      if (!targetCol || targetCol.workspaceId !== targetWsId) {
        throw new NotFoundException('Target collection not found in workspace');
      }
    }

    const moveFn =
      (this.collectionRepo as any).moveItems ||
      (this.collectionRepo as any).movePapers;

    const result = await moveFn.call(
      this.collectionRepo,
      targetWsId,
      normalizedTargetId,
      itemIds,
    );

    return {
      message: 'Items moved successfully',
      count: result.count,
      targetCollectionId: normalizedTargetId,
    };
  }

  async reorderCollections(
    workspaceId: string,
    items: ReorderItemDto[],
  ): Promise<{ collections: CollectionView[] }> {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);

    for (const item of items) {
      if (item.parentId && item.parentId === item.id) continue;
      const existing = await this.collectionRepo.findCollectionById(item.id);
      if (!existing || existing.workspaceId !== targetWsId) {
        throw new NotFoundException('Collection not found in workspace');
      }

      if (item.parentId) {
        await this.assertCollectionParentInWorkspace(item.parentId, targetWsId);
        await this.validateNoCircularHierarchy(
          item.id,
          item.parentId,
          targetWsId,
        );
      }

      await this.collectionRepo.updateCollection(item.id, {
        ...(item.parentId !== undefined && {
          parentId: item.parentId || null,
        }),
      });
    }

    return this.getCollections(targetWsId);
  }

  /**
   * Link items to a collection
   */
  async assignItemsToCollection(
    workspaceId: string,
    collectionId: string,
    dto: AssignItemsToCollectionDto,
  ): Promise<{ message: string; count: number; collectionId: string }> {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);

    const collection =
      await this.collectionRepo.findCollectionById(collectionId);
    if (!collection || collection.workspaceId !== targetWsId) {
      throw new NotFoundException('Collection not found in workspace');
    }

    const itemIds = dto.itemIds || dto.paperIds || [];
    const moveFn =
      (this.collectionRepo as any).moveItems ||
      (this.collectionRepo as any).movePapers;

    const result = await moveFn.call(
      this.collectionRepo,
      targetWsId,
      collectionId,
      itemIds,
    );

    return {
      message: 'Items linked to collection successfully',
      count: result.count,
      collectionId,
    };
  }

  /**
   * Soft-Detach: Remove item from collection without deleting item record from Library
   */
  async detachItemFromCollection(
    workspaceId: string,
    collectionId: string,
    itemId: string,
  ): Promise<{ message: string; count: number }> {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);

    const collection =
      await this.collectionRepo.findCollectionById(collectionId);
    if (!collection || collection.workspaceId !== targetWsId) {
      throw new NotFoundException('Collection not found in workspace');
    }

    const detachFn =
      (this.collectionRepo as any).detachItemFromCollection ||
      (this.collectionRepo as any).detachPaperFromCollection;

    const result = await detachFn.call(
      this.collectionRepo,
      targetWsId,
      collectionId,
      itemId,
    );

    if (result.count === 0) {
      throw new NotFoundException('Item not found in this collection');
    }

    return {
      message: 'Item detached from collection successfully',
      count: result.count,
    };
  }

  // Compatibility aliases
  async movePapers(
    workspaceId: string,
    targetCollectionId: string | null,
    itemIds: string[],
  ) {
    return this.moveItems(workspaceId, targetCollectionId, itemIds);
  }

  async assignPapersToCollection(
    workspaceId: string,
    collectionId: string,
    dto: AssignItemsToCollectionDto,
  ) {
    return this.assignItemsToCollection(workspaceId, collectionId, dto);
  }

  async detachPaperFromCollection(
    workspaceId: string,
    collectionId: string,
    itemId: string,
  ) {
    return this.detachItemFromCollection(workspaceId, collectionId, itemId);
  }

  private async getCollectionInWorkspace(
    workspaceId: string,
    collectionId: string,
  ): Promise<CollectionRecord> {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);
    const collection =
      await this.collectionRepo.findCollectionById(collectionId);

    if (!collection || collection.workspaceId !== targetWsId) {
      throw new NotFoundException('Collection not found in workspace');
    }

    return collection;
  }

  private async assertCollectionParentInWorkspace(
    parentId: string,
    workspaceId: string,
  ): Promise<void> {
    const parent = await this.collectionRepo.findCollectionById(parentId);
    if (!parent || parent.workspaceId !== workspaceId) {
      throw new NotFoundException('Parent collection not found in workspace');
    }
  }
}
