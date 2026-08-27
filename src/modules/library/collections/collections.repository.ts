import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';
import { LibraryFeatureFlagsService } from '../common/library-feature-flags';
import { VersionMismatchException } from '../common/library-mutation.dto';

export interface CreateCollectionInput {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  parentId?: string | null;
  createdById: string;
}

export interface UpdateCollectionInput {
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  parentId?: string | null;
}

@Injectable()
export class CollectionsRepository {
  private readonly logger = new Logger(CollectionsRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly featureFlags: LibraryFeatureFlagsService,
  ) {}

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
      },
    });
  }

  /**
   * Retrieves the full collection hierarchy tree for a workspace.
   */
  async findTree(workspaceId: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.collection.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Creates a new collection with version 1.
   */
  async create(
    workspaceId: string,
    input: CreateCollectionInput,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.collection.create({
      data: {
        workspaceId,
        name: input.name,
        description: input.description ?? '',
        color: input.color ?? '#3370ff',
        icon: input.icon ?? '',
        parentId: input.parentId ?? null,
        createdById: input.createdById,
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
    expectedVersion: number,
    input: UpdateCollectionInput,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const existing = await this.findById(workspaceId, id, tx);
    if (!existing) {
      throw new NotFoundException(
        `Collection ${id} not found in workspace ${workspaceId}`,
      );
    }

    if (existing.version !== expectedVersion) {
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
        name: input.name ?? existing.name,
        description: input.description ?? existing.description,
        color: input.color ?? existing.color,
        icon: input.icon ?? existing.icon,
        parentId:
          input.parentId !== undefined ? input.parentId : existing.parentId,
        version: { increment: 1 },
      },
    });
  }

  /**
   * Soft deletes a collection.
   */
  async delete(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = this.getClient(tx);
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
    const isDualWrite = this.featureFlags.isDualWriteEnabled(workspaceId);

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

    // 2. Dual-write to legacy collectionId on papers table if enabled
    if (isDualWrite) {
      this.logger.debug(
        `[DualWrite] Syncing legacy collectionId for paper ${itemId} -> ${collectionId}`,
      );
      await client.catalogItem.updateMany({
        where: { id: itemId, workspaceId },
        data: { collectionId },
      });
    }
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
    const isDualWrite = this.featureFlags.isDualWriteEnabled(workspaceId);

    // 1. Canonical delete from collection_items
    await client.collectionItem.deleteMany({
      where: {
        collectionId,
        catalogItemId: itemId,
      },
    });

    // 2. If dual-write enabled and legacy column still pointed to this collection, nullify it
    if (isDualWrite) {
      await client.catalogItem.updateMany({
        where: { id: itemId, workspaceId, collectionId },
        data: { collectionId: null },
      });
    }
  }

  /**
   * Dual-read: Retrieves catalog item IDs belonging to a collection.
   */
  async findItemIdsByCollection(
    workspaceId: string,
    collectionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = this.getClient(tx);
    const isReadNew = this.featureFlags.isReadNewEnabled(workspaceId);

    if (isReadNew) {
      // Canonical read through collection_items join
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

    // Legacy fallback read
    const legacyItems = await client.catalogItem.findMany({
      where: {
        collectionId,
        workspaceId,
        deletedAt: null,
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    return legacyItems.map((i) => i.id);
  }
}
