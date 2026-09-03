import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';
import { VersionMismatchException } from '../catalog/errors/catalog.errors';
import { CollectionDeleteStrategy } from './types/collection.types';

export interface CreateCollectionInput {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  parentId?: string | null;
  createdById?: string;
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
  private readonly logger = new Logger(CollectionsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  /**
   * Finds a collection by ID with strict workspace isolation.
   */
  async findById(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.collection.findFirst({
      where: { id, workspaceId, deletedAt: null },
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
   * Retrieves all collections for a workspace.
   */
  async findAll(workspaceId: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.collection.findMany({
      where: { workspaceId, deletedAt: null },
      include: {
        _count: {
          select: { collectionItems: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Alias for findTree / findAll.
   */
  async findTree(workspaceId: string, tx?: Prisma.TransactionClient) {
    return this.findAll(workspaceId, tx);
  }

  /**
   * Creates a new collection with version 1.
   */
  async create(
    workspaceId: string,
    userIdOrInput: string | CreateCollectionInput,
    inputOrTx?: CreateCollectionInput | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    let createdById = 'system';
    let input: CreateCollectionInput;
    let clientTx: Prisma.TransactionClient | undefined;

    if (typeof userIdOrInput === 'string') {
      createdById = userIdOrInput;
      input = inputOrTx as CreateCollectionInput;
      clientTx = tx;
    } else {
      input = userIdOrInput;
      createdById = input.createdById || 'system';
      clientTx = inputOrTx as Prisma.TransactionClient | undefined;
    }

    const client = this.getClient(clientTx);
    return client.collection.create({
      data: {
        workspaceId,
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
    workspaceId: string,
    id: string,
    inputOrVersion: UpdateCollectionInput | number,
    inputOrTx?: UpdateCollectionInput | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
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
    const existing = await this.findById(workspaceId, id, clientTx);
    if (!existing) {
      throw new NotFoundException(
        `Collection ${id} not found in workspace ${workspaceId}`,
      );
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
    workspaceId: string,
    id: string,
    strategyOrTx?: CollectionDeleteStrategy | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const clientTx = typeof strategyOrTx === 'string' ? tx : strategyOrTx;
    const strategy = typeof strategyOrTx === 'string' ? strategyOrTx : 'orphan';

    const client = this.getClient(clientTx);

    if (strategy === 'cascade') {
      // Find all child collections and delete recursively
      const children = await client.collection.findMany({
        where: { workspaceId, parentId: id, deletedAt: null },
      });
      for (const child of children) {
        await this.delete(workspaceId, child.id, 'cascade', clientTx);
      }
    } else {
      // Orphan child collections by resetting parentId to null
      await client.collection.updateMany({
        where: { workspaceId, parentId: id, deletedAt: null },
        data: { parentId: null },
      });
    }

    const result = await client.collection.updateMany({
      where: { id, workspaceId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return result.count > 0;
  }

  /**
   * Adds an item to a collection with dual-write semantics.
   */
  async addItemToCollection(
    workspaceId: string,
    collectionId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);

    // 1. Canonical write into collection_items (M:N)
    await client.collectionItem.upsert({
      where: {
        collectionId_catalogItemId: {
          collectionId,
          catalogItemId: itemId,
        },
      },
      create: {
        collectionId,
        catalogItemId: itemId,
        sortOrder: 0,
      },
      update: {},
    });
  }

  async addItem(
    workspaceId: string,
    collectionId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.addItemToCollection(workspaceId, collectionId, itemId, tx);
  }

  /**
   * Removes an item from a collection.
   */
  async removeItemFromCollection(
    workspaceId: string,
    collectionId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);

    // 1. Canonical delete from collection_items
    await client.collectionItem.deleteMany({
      where: {
        collectionId,
        catalogItemId: itemId,
      },
    });
  }

  async removeItem(
    workspaceId: string,
    collectionId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.removeItemFromCollection(workspaceId, collectionId, itemId, tx);
  }

  /**
   * Moves items to target collection.
   */
  async moveItems(
    workspaceId: string,
    targetCollectionId: string | null,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);

    if (targetCollectionId === null) {
      // Remove items from all collections (unfiled)
      await client.collectionItem.deleteMany({
        where: {
          catalogItemId: { in: itemIds },
        },
      });
    } else {
      for (const itemId of itemIds) {
        await this.addItemToCollection(
          workspaceId,
          targetCollectionId,
          itemId,
          tx,
        );
      }
    }
  }

  /**
   * Reorders collections hierarchy and indices.
   */
  async reorder(
    workspaceId: string,
    collections: Array<{
      id: string;
      parentId?: string | null;
      orderIndex?: number;
    }>,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);
    for (const c of collections) {
      await client.collection.updateMany({
        where: { id: c.id, workspaceId },
        data: {
          ...(c.parentId !== undefined ? { parentId: c.parentId } : {}),
        },
      });
    }
  }

  /**
   * Retrieves catalog item IDs belonging to a collection.
   */
  async findItemIdsByCollection(
    workspaceId: string,
    collectionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = this.getClient(tx);

    const items = await client.collectionItem.findMany({
      where: {
        collectionId,
        catalogItem: {
          workspaceId,
          deletedAt: null,
        },
      },
      select: { catalogItemId: true },
      orderBy: { sortOrder: 'asc' },
    });

    return items.map((i) => i.catalogItemId);
  }
}
