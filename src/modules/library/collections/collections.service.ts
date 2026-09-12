import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TransactionHelpers } from '../outbox/transaction.service';
import type {
  UpsertSyncCollectionCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../sync/types/sync.types';
import { CollectionsRepository } from './collections.repository';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
  AssignItemsToCollectionDto,
} from './dto/collections.dto';
import {
  CollectionDeleteStrategy,
  CollectionTreeNode,
} from './types/collections.types';
import {
  buildCollectionTree,
  normalizeParentId,
} from './utils/collections.utils';
import { TreeEngine } from './engines/tree.engine';
import { PrismaService } from '../../../core/database/prisma.service';

import { RedisCacheService } from '../../../core/cache/redis.service';
import { LIBRARY_REDIS_KEYS } from '../core/constants/redis-keys.constant';

@Injectable()
export class CollectionsService {
  private readonly logger = new Logger(CollectionsService.name);

  constructor(
    private readonly repo: CollectionsRepository,
    private readonly prisma: PrismaService,
    @Optional()
    private readonly tree: TreeEngine = new TreeEngine(),
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateCollectionsCache(userId: string): Promise<void> {
    if (this.cache) {
      await this.cache.delPattern(
        LIBRARY_REDIS_KEYS.collectionsPattern(userId),
      );
    }
  }

  async getCollections(userId: string) {
    const fetchCollections = async () => {
      const rawCollections = await this.repo.findAll(userId);
      const collections = rawCollections.map((c: any) => ({
        ...c,
        itemCount: c.itemCount ?? c._count?.collectionItems ?? 0,
        itemsCount: c.itemsCount ?? c._count?.collectionItems ?? 0,
        paperCount: c.paperCount ?? c._count?.collectionItems ?? 0,
      }));
      return {
        collections,
        total: collections.length,
      };
    };

    if (this.cache) {
      return this.cache.wrap(
        LIBRARY_REDIS_KEYS.collections(userId),
        fetchCollections,
        300,
      );
    }
    return fetchCollections();
  }

  async getCollectionTree(
    userId: string,
  ): Promise<{ tree: CollectionTreeNode[] }> {
    const fetchTree = async () => {
      const collections = await this.repo.findAll(userId);

      return { tree: this.tree.buildTree(collections) };
    };

    if (this.cache) {
      return this.cache.wrap(
        LIBRARY_REDIS_KEYS.collectionTree(userId),
        fetchTree,
        300,
      );
    }
    return fetchTree();
  }

  async getCollectionById(userId: string, collectionId: string) {
    const raw = await this.repo.findById(userId, collectionId);
    if (!raw) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }
    const count =
      (raw as { _count?: { collectionItems?: number } })._count
        ?.collectionItems ??
      (raw as { itemCount?: number }).itemCount ??
      0;
    const collection = {
      ...raw,
      itemCount: count,
      itemsCount: count,
      paperCount: count,
    };
    return { collection };
  }

  async createCollection(
    userId: string,
    dto: CreateCollectionDto,
  ) {
    // Normalize parentId from parentId or parent, treating 'root' or empty string as null
    const rawParentId = normalizeParentId(
      dto.parentId !== undefined ? dto.parentId : dto.parent,
    );

    if (rawParentId) {
      const parent = await this.repo.findById(
        userId,
        rawParentId,
      );
      if (!parent) {
        throw new BadRequestException(
          `Parent collection not found: ${rawParentId}`,
        );
      }
    }

    const collection = await this.repo.create(userId, userId, {
      name: dto.name,
      description: dto.description,
      color: dto.color,
      icon: dto.icon,
      parentId: rawParentId,
    });

    await this.invalidateCollectionsCache(userId);
    return { collection };
  }

  async updateCollection(
    userId: string,
    collectionId: string,
    dto: UpdateCollectionDto,
  ) {
    const existing = await this.repo.findById(
      userId,
      collectionId,
    );
    if (!existing) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    const rawParentId = normalizeParentId(
      dto.parentId !== undefined ? dto.parentId : dto.parent,
    );

    if (rawParentId) {
      if (rawParentId === collectionId) {
        throw new BadRequestException('A collection cannot be its own parent');
      }
      const parent = await this.repo.findById(
        userId,
        rawParentId,
      );
      if (!parent) {
        throw new BadRequestException(
          `Parent collection not found: ${rawParentId}`,
        );
      }

      // Assert no indirect or direct circular loops in collection hierarchy
      const allCollections = await this.repo.findAll(userId);
      this.tree.assertNoCycle(allCollections, collectionId, rawParentId);
    }

    const collection = await this.repo.update(
      userId,
      collectionId,
      {
        ...dto,
        parentId: rawParentId,
      },
    );
    await this.invalidateCollectionsCache(userId);
    return { collection };
  }

  async deleteCollection(
    userId: string,
    collectionId: string,
    strategy: CollectionDeleteStrategy = 'orphan',
  ) {
    const existing = await this.repo.findById(
      userId,
      collectionId,
    );
    if (!existing) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    await this.repo.delete(userId, collectionId, strategy);
    await this.invalidateCollectionsCache(userId);
    return { success: true };
  }

  async moveItems(
    userId: string,
    collectionId: string,
    itemIds: string[],
  ) {
    if (collectionId !== 'unfiled') {
      const collection = await this.repo.findById(
        userId,
        collectionId,
      );
      if (!collection) {
        throw new NotFoundException(`Collection not found: ${collectionId}`);
      }
    }

    const destinationCollectionId =
      collectionId === 'unfiled' ? null : collectionId;
    await this.repo.moveItems(
      userId,
      destinationCollectionId,
      itemIds,
    );

    await this.invalidateCollectionsCache(userId);
    return {
      message: 'Items moved successfully',
      count: itemIds.length,
      targetCollectionId: destinationCollectionId,
    };
  }

  async reorderCollections(
    userId: string,
    collections: Array<{
      id: string;
      parentId?: string | null;
      orderIndex?: number;
    }>,
  ) {
    await this.repo.reorder(userId, collections);
    const updated = await this.repo.findAll(userId);
    await this.invalidateCollectionsCache(userId);
    return { collections: updated };
  }

  async assignItemsToCollection(
    userId: string,
    collectionId: string,
    dto: AssignItemsToCollectionDto,
  ) {
    const collection = await this.repo.findById(
      userId,
      collectionId,
    );
    if (!collection) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    const ids = dto.itemIds || dto.paperIds || [];
    if (ids.length === 0) {
      return { success: true, count: 0 };
    }

    // 1. Verify all itemIds belong to this user scope
    const validItems = await this.prisma.item.findMany({
      where: {
        id: { in: ids },
        userId,
        deletedAt: null,
      },
      select: { id: true },
    });

    const validIdSet = new Set(validItems.map((it) => it.id));
    const invalidIds = ids.filter((id) => !validIdSet.has(id));
    if (invalidIds.length > 0) {
      throw new BadRequestException(
        `One or more items do not belong to library: ${invalidIds.join(', ')}`,
      );
    }

    // 2. Batch add items to collection using createMany
    await this.repo.addItems(userId, collectionId, ids);

    await this.invalidateCollectionsCache(userId);
    return { success: true, count: ids.length };
  }

  async detachItemFromCollection(
    userId: string,
    collectionId: string,
    itemId: string,
  ) {
    const collection = await this.repo.findById(
      userId,
      collectionId,
    );
    if (!collection) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    // Assert item belongs to scope
    const item = await this.prisma.item.findFirst({
      where: {
        id: itemId,
        userId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!item) {
      throw new NotFoundException(`Item not found in library: ${itemId}`);
    }

    await this.repo.removeItem(userId, collectionId, itemId);
    await this.invalidateCollectionsCache(userId);
    return { success: true };
  }

  /**
   * Sync protocol adapter: transactional upsert for a Collection from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncCollectionCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    const targetUserId = command.userId || (command as any).projectId || '';
    if (command.existingId) {
      const existing = await tx.collection.findUnique({
        where: { id: command.existingId },
      });

      if (!existing) {
        throw new NotFoundException(
          `Collection ${command.existingId} not found`,
        );
      }

      const updated = await tx.collection.update({
        where: { id: command.existingId },
        data: {
          name: command.name,
          description: command.description,
          parentId: command.parentCollectionId || null,
          version: { increment: 1 },
        },
      });

      await helpers.appendChange(targetUserId, {
        entityType: 'Collection',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: { name: command.name },
      });

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      const created = await tx.collection.create({
        data: {
          userId: targetUserId,
          name: command.name,
          description: command.description,
          parentId: command.parentCollectionId || null,
          createdById: command.userId,
          version: 1,
        },
      });

      await helpers.appendChange(targetUserId, {
        entityType: 'Collection',
        entityId: created.id,
        action: 'create',
        version: created.version,
        data: { name: command.name },
      });

      await helpers.publishOutbox(
        targetUserId,
        created.id,
        'library.collection.created',
        { collectionId: created.id },
      );

      return { id: created.id, isNew: true, version: created.version };
    }
  }

  /**
   * Sync protocol adapter: transactional soft-deletion for a Collection from an external sync batch.
   */
  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const targetUserId = command.userId || (command as any).projectId || '';
    const { entityId } = command;
    const existing = await tx.collection.findUnique({
      where: { id: entityId },
    });
    if (!existing) return;

    await tx.collection.update({
      where: { id: entityId },
      data: { deletedAt: new Date() },
    });
    await helpers.appendChange(targetUserId, {
      entityType: 'Collection',
      entityId,
      action: 'delete',
      version: existing.version + 1,
    });
    await helpers.recordTombstone(targetUserId, {
      entityType: 'Collection',
      entityId,
    });
  }

  /**
   * Domain merge helper: reassigns all collection memberships from duplicate items to a target item.
   */
  async transferItemMemberships(
    sourceItemIds: string[],
    targetItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;

    const primaryItems = await tx.collectionItem.findMany({
      where: { itemId: targetItemId },
      select: { collectionId: true },
    });
    const primaryCollectionIds = new Set(
      primaryItems.map((ci) => ci.collectionId),
    );

    const dupItems = await tx.collectionItem.findMany({
      where: { itemId: { in: sourceItemIds } },
      select: { collectionId: true },
    });

    for (const dup of dupItems) {
      if (!primaryCollectionIds.has(dup.collectionId)) {
        await tx.collectionItem.upsert({
          where: {
            collectionId_itemId: {
              collectionId: dup.collectionId,
              itemId: targetItemId,
            },
          },
          create: {
            itemId: targetItemId,
            collectionId: dup.collectionId,
          },
          update: {},
        });
        primaryCollectionIds.add(dup.collectionId);
      }
    }

    await tx.collectionItem.deleteMany({
      where: { itemId: { in: sourceItemIds } },
    });
  }

  /**
   * Sync protocol domain helper: reconciles collection memberships for an item within a transaction.
   */
  async syncCollectionsToItem(
    tx: Prisma.TransactionClient,
    tenantId: string,
    itemId: string,
    targetCollectionIds: string[],
  ): Promise<void> {
    const rawIds = targetCollectionIds.filter(
      (id): id is string => typeof id === 'string' && id.trim().length > 0,
    );
    const uniqueIds = Array.from(new Set(rawIds));

    // Delete unlinked collection associations
    await tx.collectionItem.deleteMany({
      where: {
        itemId,
        ...(uniqueIds.length > 0 ? { collectionId: { notIn: uniqueIds } } : {}),
      },
    });

    if (uniqueIds.length === 0) return;

    // Batch verify collections belong to tenant in a single query (eliminates N+1)
    const validCollections = await tx.collection.findMany({
      where: {
        id: { in: uniqueIds },
        userId: tenantId,
        deletedAt: null,
      },
      select: { id: true },
    });

    const validIdSet = new Set(validCollections.map((c) => c.id));
    const toInsert = uniqueIds
      .filter((id) => validIdSet.has(id))
      .map((collectionId, index) => ({
        collectionId,
        itemId,
        sortOrder: index,
      }));

    if (toInsert.length > 0) {
      await tx.collectionItem.createMany({
        data: toInsert,
        skipDuplicates: true,
      });
    }
  }
}
