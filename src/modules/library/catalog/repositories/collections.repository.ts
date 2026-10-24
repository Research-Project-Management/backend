import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { VersionMismatchException } from '@/modules/library/core/errors/version-mismatch.exception';
import { CollectionDeleteStrategy } from '@/modules/library/catalog/types/collections.types';
import { TreeEngine } from '@/modules/library/catalog/domain/tree.engine';

export interface CreateCollectionInput {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  parentId?: string | null;
  createdById?: string;
  projectId?: string | null;
}

export interface UpdateCollectionInput {
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  parentId?: string | null;
  version?: number;
}

@Injectable()
export class CollectionsRepository {
  private readonly treeEngine = new TreeEngine();

  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  private resolveProjectScopeId(projectId?: string | null): string | undefined {
    const normalized = normalizeProjectScopeId(projectId);
    return normalized && isUUID(normalized) ? normalized : undefined;
  }

  private buildScopeWhere(
    userId: string,
    projectId?: string | null,
  ): Prisma.CollectionWhereInput {
    const validProjectId = this.resolveProjectScopeId(projectId);
    return validProjectId
      ? { projectId: validProjectId }
      : { userId, projectId: null };
  }

  /**
   * Finds a collection by ID with strict user/project isolation.
   */
  async findById(
    userId: string,
    id: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    const client = this.getClient(tx);
    const scopeWhere = this.buildScopeWhere(userId, projectId);
    const where: Prisma.CollectionWhereInput = {
      id,
      deletedAt: null,
      ...scopeWhere,
    };
    return client.collection.findFirst({
      where,
      include: {
        children: {
          where: { deletedAt: null },
        },
        _count: {
          select: { collectionItems: true },
        },
      },
    });
  }

  /**
   * Retrieves all collections for a user or project.
   */
  async findAll(
    userId: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const where: Prisma.CollectionWhereInput = {
      ...this.buildScopeWhere(userId, projectId),
      deletedAt: null,
    };

    return client.collection.findMany({
      where,
      include: {
        _count: {
          select: { collectionItems: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Creates a new collection with version 1.
   */
  async create(
    userId: string,
    input: CreateCollectionInput,
    tx?: Prisma.TransactionClient,
  ) {
    const effectiveProjectId =
      this.resolveProjectScopeId(input.projectId) ?? null;

    const client = this.getClient(tx);
    return client.collection.create({
      data: {
        userId,
        projectId: effectiveProjectId,
        name: input.name,
        description: input.description ?? '',
        color: input.color ?? '#3370ff',
        icon: input.icon ?? '',
        parentId: input.parentId ?? null,
        createdById: input.createdById || userId,
        version: 1,
      },
    });
  }

  /**
   * Updates a collection enforcing optimistic concurrency control.
   */
  async update(
    userId: string,
    id: string,
    input: UpdateCollectionInput,
    tx?: Prisma.TransactionClient,
    projectId?: string,
    expectedVersion?: number,
  ) {
    const versionToVerify = expectedVersion ?? input.version;
    const client = this.getClient(tx);
    const existing = await this.findById(userId, id, tx, projectId);
    if (!existing) {
      throw new NotFoundException(`Collection ${id} not found`);
    }

    if (versionToVerify !== undefined && existing.version !== versionToVerify) {
      throw new VersionMismatchException({
        aggregateType: 'Collection',
        entityId: id,
        currentVersion: existing.version,
        providedVersion: versionToVerify,
      });
    }

    return client.collection.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        version: { increment: 1 },
      },
    });
  }

  /**
   * Soft deletes a collection according to strategy.
   */
  async delete(
    userId: string,
    id: string,
    strategy: CollectionDeleteStrategy = 'orphan',
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    const scopeWhere = this.buildScopeWhere(userId, projectId);
    const now = new Date();
    let deletedCollectionIds: string[] = [id];
    let deletedItemIds: string[] = [];

    if (strategy === 'cascade') {
      const allCollections = await client.collection.findMany({
        where: { ...scopeWhere, deletedAt: null },
        select: { id: true, parentId: true },
      });
      const descendantIds = this.treeEngine.getDescendantIds(
        allCollections || [],
        id,
      );
      const targetCollectionIds = [id, ...descendantIds];
      deletedCollectionIds = targetCollectionIds;

      const links = await client.collectionItem.findMany({
        where: {
          collectionId:
            targetCollectionIds.length === 1
              ? targetCollectionIds[0]
              : { in: targetCollectionIds },
        },
        select: { itemId: true },
      });
      const itemIds = Array.from(new Set(links.map((l) => l.itemId)));
      if (itemIds.length > 0) {
        deletedItemIds = itemIds;
        const validProjectId = normalizeProjectScopeId(projectId);
        await client.item.updateMany({
          where: {
            ...(validProjectId
              ? { projectId: validProjectId }
              : { userId, projectId: null }),
            id: { in: itemIds },
            deletedAt: null,
          },
          data: {
            deletedAt: now,
            version: { increment: 1 },
          },
        });

        await client.note?.updateMany?.({
          where: {
            itemId: { in: itemIds },
            deletedAt: null,
          },
          data: { deletedAt: now },
        });

        await client.attachment?.updateMany?.({
          where: {
            itemId: { in: itemIds },
            deletedAt: null,
          },
          data: { deletedAt: now },
        });
      }

      const result = await client.collection.updateMany({
        where: {
          id:
            targetCollectionIds.length === 1
              ? targetCollectionIds[0]
              : { in: targetCollectionIds },
          ...scopeWhere,
          deletedAt: null,
        },
        data: { deletedAt: now },
      });
      return result.count > 0;
    } else {
      await client.collection.updateMany({
        where: { ...scopeWhere, parentId: id, deletedAt: null },
        data: { parentId: null },
      });
    }

    const result = await client.collection.updateMany({
      where: { id, ...scopeWhere, deletedAt: null },
      data: { deletedAt: now },
    });
    return result.count > 0;
  }

  /**
   * Adds items to a collection.
   */
  async addItemsToCollection(
    userId: string,
    collectionId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string | null,
  ): Promise<void> {
    if (itemIds.length === 0) return;
    const client = this.getClient(tx);

    let validItemIds = itemIds;
    if (client.item?.findMany) {
      const validProjectId = normalizeProjectScopeId(projectId);
      const scopeWhere: Prisma.ItemWhereInput = validProjectId
        ? { projectId: validProjectId }
        : { userId, projectId: null };
      const matched = await client.item.findMany({
        where: {
          ...scopeWhere,
          id: { in: itemIds },
          deletedAt: null,
        },
        select: { id: true },
      });
      validItemIds = matched.map((m: { id: string }) => m.id);
    }

    if (validItemIds.length === 0) return;

    await client.collectionItem.createMany({
      data: validItemIds.map((itemId) => ({
        collectionId,
        itemId,
        sortOrder: 0,
      })),
      skipDuplicates: true,
    });
  }

  /**
   * Removes an item from a collection.
   */
  async removeItemFromCollection(
    _userId: string,
    collectionId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);

    await client.collectionItem.deleteMany({
      where: {
        collectionId,
        itemId,
      },
    });
  }

  async removeItems(
    collectionId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!itemIds || itemIds.length === 0) return;
    const client = this.getClient(tx);
    await client.collectionItem.deleteMany({
      where: {
        collectionId,
        itemId: { in: itemIds },
      },
    });
  }

  /**
   * Moves items to target collection.
   */
  async moveItems(
    userId: string,
    targetCollectionId: string | null,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<void> {
    const client = this.getClient(tx);

    if (targetCollectionId === null) {
      const validProjectId = normalizeProjectScopeId(projectId);
      const collectionScope: Prisma.CollectionWhereInput = validProjectId
        ? { projectId: validProjectId }
        : { userId, projectId: null };

      await client.collectionItem.deleteMany({
        where: {
          itemId: { in: itemIds },
          collection: collectionScope,
        },
      });
    } else {
      await this.addItemsToCollection(userId, targetCollectionId, itemIds, tx);
    }
  }

  /**
   * Reorders collections hierarchy and indices.
   */
  async reorder(
    userId: string,
    collections: Array<{
      id: string;
      parentId?: string | null;
      orderIndex?: number;
    }>,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const scopeWhere = this.buildScopeWhere(userId, projectId);
    const runUpdates = async (
      client: Prisma.TransactionClient | PrismaService,
    ) => {
      await Promise.all(
        collections.map((c) =>
          client.collection.updateMany({
            where: { id: c.id, ...scopeWhere },
            data: {
              ...(c.parentId !== undefined ? { parentId: c.parentId } : {}),
              ...(c.orderIndex !== undefined
                ? { orderIndex: c.orderIndex }
                : {}),
            },
          }),
        ),
      );
    };

    if (!tx && this.prisma.$transaction) {
      await this.prisma.$transaction(async (innerTx) => {
        await runUpdates(innerTx);
      });
    } else {
      await runUpdates(this.getClient(tx));
    }
  }

  /**
   * Retrieves item IDs belonging to a collection.
   */
  async findItemIdsByCollection(
    userId: string,
    collectionId: string,
    tx?: Prisma.TransactionClient,
    limit?: number,
    projectId?: string,
  ): Promise<string[]> {
    const client = this.getClient(tx);
    const validProjectId = this.resolveProjectScopeId(projectId);

    const items = await client.collectionItem.findMany({
      where: {
        collectionId,
        item: {
          ...(validProjectId
            ? { projectId: validProjectId }
            : { userId, projectId: null }),
          deletedAt: null,
        },
      },
      select: { itemId: true },
      orderBy: { sortOrder: 'asc' },
      take: limit ?? 500,
    });

    return items.map((i: { itemId: string }) => i.itemId);
  }

  async findOwnedItemIds(
    itemIds: string[],
    scopeWhere: Prisma.ItemWhereInput,
  ): Promise<string[]> {
    const owned = await this.prisma.item.findMany({
      where: { id: { in: itemIds }, ...scopeWhere },
      select: { id: true },
    });
    return owned.map((i) => i.id);
  }

  async findValidItemIds(
    itemIds: string[],
    scopeWhere: Prisma.ItemWhereInput,
  ): Promise<string[]> {
    const valid = await this.prisma.item.findMany({
      where: { id: { in: itemIds }, ...scopeWhere, deletedAt: null },
      select: { id: true },
    });
    return valid.map((i) => i.id);
  }

  async verifyItemInScope(
    itemId: string,
    scopeWhere: Prisma.ItemWhereInput,
  ): Promise<boolean> {
    const item = await this.prisma.item.findFirst({
      where: { id: itemId, ...scopeWhere, deletedAt: null },
      select: { id: true },
    });
    return Boolean(item);
  }
}
