import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { VersionMismatchException } from '@/modules/library/core/errors/version-mismatch.exception';
import { CollectionDeleteStrategy } from '@/modules/library/catalog/types/collections.types';

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
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  private normalizeProjectScopeId(
    projectId?: string | null,
  ): string | undefined {
    if (
      projectId &&
      projectId !== 'user' &&
      projectId !== 'me' &&
      projectId !== 'personal' &&
      isUUID(projectId)
    ) {
      return projectId;
    }
    return undefined;
  }

  private buildScopeWhere(
    userId: string,
    projectId?: string | null,
  ): Prisma.CollectionWhereInput {
    const validProjectId = this.normalizeProjectScopeId(projectId);
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
    projectIdOrTx?: string | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    const projectId =
      typeof projectIdOrTx === 'string'
        ? this.normalizeProjectScopeId(projectIdOrTx)
        : undefined;
    const clientTx = typeof projectIdOrTx === 'object' ? projectIdOrTx : tx;
    const client = this.getClient(clientTx);
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
    userIdOrInput: string | CreateCollectionInput,
    inputOrTx?: CreateCollectionInput | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    let createdById = userId;
    let input: CreateCollectionInput;
    let clientTx: Prisma.TransactionClient | undefined;

    if (typeof userIdOrInput === 'string') {
      createdById = userIdOrInput;
      input = inputOrTx as CreateCollectionInput;
      clientTx = tx;
    } else {
      input = userIdOrInput;
      createdById = input.createdById || userId;
      clientTx = inputOrTx as Prisma.TransactionClient | undefined;
    }

    const effectiveProjectId =
      this.normalizeProjectScopeId(input.projectId) ?? null;

    const client = this.getClient(clientTx);
    return client.collection.create({
      data: {
        userId,
        projectId: effectiveProjectId,
        name: input.name,
        description: input.description ?? '',
        color: input.color ?? '#3370ff',
        icon: input.icon ?? '',
        parentId: input.parentId ?? null,
        createdById,
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
    inputOrVersion: UpdateCollectionInput | number,
    inputOrTx?: UpdateCollectionInput | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    let expectedVersion: number | undefined;
    let input: UpdateCollectionInput;
    let clientTx: Prisma.TransactionClient | undefined;

    if (typeof inputOrVersion === 'number') {
      expectedVersion = inputOrVersion;
      input = inputOrTx as UpdateCollectionInput;
      clientTx = tx;
    } else {
      input = inputOrVersion;
      expectedVersion = input.version;
      clientTx = inputOrTx as Prisma.TransactionClient | undefined;
    }

    const client = this.getClient(clientTx);
    const existing = await this.findById(userId, id, clientTx, projectId);
    if (!existing) {
      throw new NotFoundException(`Collection ${id} not found`);
    }

    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new VersionMismatchException({
        aggregateType: 'Collection',
        entityId: id,
        currentVersion: existing.version,
        providedVersion: expectedVersion,
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
    strategyOrTx?: CollectionDeleteStrategy | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<boolean> {
    const clientTx = typeof strategyOrTx === 'string' ? tx : strategyOrTx;
    const strategy = typeof strategyOrTx === 'string' ? strategyOrTx : 'orphan';

    const client = this.getClient(clientTx);
    const scopeWhere = this.buildScopeWhere(userId, projectId);

    if (strategy === 'cascade') {
      const children = await client.collection.findMany({
        where: { ...scopeWhere, parentId: id, deletedAt: null },
      });
      for (const child of children) {
        await this.delete(userId, child.id, 'cascade', clientTx, projectId);
      }
    } else {
      await client.collection.updateMany({
        where: { ...scopeWhere, parentId: id, deletedAt: null },
        data: { parentId: null },
      });
    }

    const result = await client.collection.updateMany({
      where: { id, ...scopeWhere, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return result.count > 0;
  }

  /**
   * Adds items to a collection.
   */
  async addItemsToCollection(
    _userId: string,
    collectionId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (itemIds.length === 0) return;
    const client = this.getClient(tx);

    await client.collectionItem.createMany({
      data: itemIds.map((itemId) => ({
        collectionId,
        itemId,
        sortOrder: 0,
      })),
      skipDuplicates: true,
    });
  }

  async addItems(
    userId: string,
    collectionId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.addItemsToCollection(userId, collectionId, itemIds, tx);
  }

  async addItemToCollection(
    userId: string,
    collectionId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.addItemsToCollection(userId, collectionId, [itemId], tx);
  }

  async addItem(
    userId: string,
    collectionId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.addItemsToCollection(userId, collectionId, [itemId], tx);
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

  async removeItem(
    userId: string,
    collectionId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.removeItemFromCollection(userId, collectionId, itemId, tx);
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
  ): Promise<void> {
    const client = this.getClient(tx);

    if (targetCollectionId === null) {
      await client.collectionItem.deleteMany({
        where: {
          itemId: { in: itemIds },
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
      for (const c of collections) {
        await client.collection.updateMany({
          where: { id: c.id, ...scopeWhere },
          data: {
            ...(c.parentId !== undefined ? { parentId: c.parentId } : {}),
            ...(c.orderIndex !== undefined ? { orderIndex: c.orderIndex } : {}),
          },
        });
      }
    };

    if (!tx && typeof this.prisma.$transaction === 'function') {
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
  ): Promise<string[]> {
    const client = this.getClient(tx);

    const items = await client.collectionItem.findMany({
      where: {
        collectionId,
        item: {
          userId,
          deletedAt: null,
        },
      },
      select: { itemId: true },
      orderBy: { sortOrder: 'asc' },
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
