import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { Prisma } from '@prisma/client';
import { normalizeProjectScopeId, resolveSpaceId, sortLockKeys } from '@/modules/library/core';
import { VersionMismatchException } from '@/modules/library/core/errors/domain.exception';
import { CollectionDeleteStrategy } from '@/modules/library/catalog/types/catalog.types';
import { TreeEngine } from '@/modules/library/catalog/domain/state.domain';

interface CreateCollectionInput {
  name: string; description?: string; color?: string; icon?: string;
  parentId?: string | null; createdById?: string; projectId?: string | null;
}

interface UpdateCollectionInput {
  name?: string; description?: string; color?: string; icon?: string;
  parentId?: string | null; version?: number;
}

@Injectable()
export class CollectionsRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly treeEngine: TreeEngine = new TreeEngine(),
  ) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  private resolveProjectScopeId(projectId?: string | null): string | undefined {
    const normalized = normalizeProjectScopeId(projectId);
    return normalized && isUuid(normalized) ? normalized : undefined;
  }

  private buildScopeWhere(userId: string, projectId?: string | null): Prisma.LibraryCollectionWhereInput {
    const validProjectId = this.resolveProjectScopeId(projectId);
    return { spaceId: resolveSpaceId({ userId, projectId: validProjectId }) };
  }

  async findById(userId: string, id: string, tx?: Prisma.TransactionClient, projectId?: string) {
    const client = this.getClient(tx);
    const scopeWhere = this.buildScopeWhere(userId, projectId);
    return client.libraryCollection.findFirst({
      where: { id, deletedAt: null, ...scopeWhere },
      include: {
        children: { where: { deletedAt: null } },
        _count: { select: { collectionItems: { where: { item: { deletedAt: null } } } } },
      },
    });
  }

  async findAll(userId: string, projectId?: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.libraryCollection.findMany({
      where: { ...this.buildScopeWhere(userId, projectId), deletedAt: null },
      include: {
        collectionItems: { where: { item: { deletedAt: null } }, select: { itemId: true } },
        _count: { select: { collectionItems: { where: { item: { deletedAt: null } } } } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findAllHierarchyNodes(
    userId: string, projectId?: string, tx?: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; parentId: string | null }>> {
    const client = this.getClient(tx);
    return client.libraryCollection.findMany({
      where: { ...this.buildScopeWhere(userId, projectId), deletedAt: null },
      select: { id: true, parentId: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(userId: string, input: CreateCollectionInput, tx?: Prisma.TransactionClient) {
    const effectiveProjectId = this.resolveProjectScopeId(input.projectId) ?? null;
    const spaceId = resolveSpaceId({ userId, projectId: effectiveProjectId });
    const client = this.getClient(tx);
    if (input.parentId && typeof client.libraryCollection?.findFirst === 'function') {
      const scopeWhere = { spaceId };
      const parent = await client.libraryCollection.findFirst({
        where: { id: input.parentId, ...scopeWhere, deletedAt: null },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException(`Parent collection ${input.parentId} not found in scope`);
    }
    return client.libraryCollection.create({
      data: {
        spaceId, name: input.name,
        description: input.description ?? '', color: input.color ?? '#3370ff',
        icon: input.icon ?? '', parentId: input.parentId ?? null,
        createdById: input.createdById || userId, version: 1,
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
    const scopeWhere = this.buildScopeWhere(userId, projectId);
    const existing = await this.findById(userId, id, tx, projectId);
    if (!existing) {
      throw new NotFoundException(`Collection ${id} not found`);
    }

    if (
      input.parentId &&
      input.parentId !== existing.parentId &&
      typeof client.libraryCollection?.findFirst === 'function'
    ) {
      const parent = await client.libraryCollection.findFirst({
        where: {
          id: input.parentId,
          ...scopeWhere,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!parent) {
        throw new NotFoundException(
          `Parent collection ${input.parentId} not found in scope`,
        );
      }
    }

    if (versionToVerify !== undefined && existing.version !== versionToVerify) {
      throw new VersionMismatchException({
        aggregateType: 'Collection',
        entityId: id,
        currentVersion: existing.version,
        providedVersion: versionToVerify,
      });
    }

    const updateData = {
      updatedById: userId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      version: { increment: 1 },
    };

    if (versionToVerify !== undefined && client.libraryCollection?.updateMany) {
      const affected = await client.libraryCollection.updateMany({
        where: {
          id,
          ...scopeWhere,
          deletedAt: null,
          version: versionToVerify,
        },
        data: updateData,
      });
      if (affected.count === 0) {
        const current = await this.findById(userId, id, tx, projectId);
        throw new VersionMismatchException({
          aggregateType: 'Collection',
          entityId: id,
          currentVersion: current?.version ?? existing.version,
          providedVersion: versionToVerify,
        });
      }
      const reloaded = await this.findById(userId, id, tx, projectId);
      if (reloaded && reloaded.version > existing.version) {
        return reloaded;
      }
      return {
        ...existing,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        version: (existing.version ?? 1) + 1,
      };
    }

    return client.libraryCollection.update({
      where: {
        id,
        ...(versionToVerify !== undefined ? { version: versionToVerify } : {}),
      },
      data: updateData,
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
    preResolved?: {
      targetCollectionIds?: string[];
      itemIds?: string[];
    },
  ): Promise<boolean> {
    const client = this.getClient(tx);
    const scopeWhere = this.buildScopeWhere(userId, projectId);
    const now = new Date();

    if (strategy === 'cascade') {
      let targetCollectionIds = preResolved?.targetCollectionIds;
      if (!targetCollectionIds || targetCollectionIds.length === 0) {
        const allCollections = await client.libraryCollection.findMany({
          where: { ...scopeWhere, deletedAt: null },
          select: { id: true, parentId: true },
        });
        const descendantIds = this.treeEngine.getDescendantIds(
          allCollections || [],
          id,
        );
        targetCollectionIds = [id, ...descendantIds];
      }

      let itemIds = preResolved?.itemIds;
      if (itemIds === undefined) {
        const links = await client.libraryCollectionItem.findMany({
          where: {
            collectionId:
              targetCollectionIds.length === 1
                ? targetCollectionIds[0]
                : { in: targetCollectionIds },
          },
          select: { itemId: true },
        });
        itemIds = Array.from(new Set(links.map((l) => l.itemId)));
      }
      if (itemIds.length > 0) {
        const validProjectId = normalizeProjectScopeId(projectId);
        const itemScopeWhere: Prisma.LibraryItemWhereInput = {
          spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
        };

        let orphanItemIds = itemIds;
        if (typeof client.libraryItem?.findMany === 'function') {
          const orphanItems = await client.libraryItem.findMany({
            where: {
              ...itemScopeWhere,
              id: { in: itemIds },
              deletedAt: null,
              collectionItems: {
                none: {
                  collectionId: { notIn: targetCollectionIds },
                  collection: { deletedAt: null },
                },
              },
            },
            select: { id: true },
          });
          orphanItemIds = orphanItems.map((i: { id: string }) => i.id);
        }

        if (orphanItemIds.length > 0) {
          await client.libraryItem.updateMany({
            where: {
              ...itemScopeWhere,
              id: { in: orphanItemIds },
              deletedAt: null,
              collectionItems: {
                none: {
                  collectionId: { notIn: targetCollectionIds },
                  collection: { deletedAt: null },
                },
              },
            },
            data: {
              deletedAt: now,
              deletedById: userId,
              noteCount: 0,
              attachmentCount: 0,
              hasFile: false,
              version: { increment: 1 },
            },
          });

          await Promise.all([
            client.libraryNote?.updateMany?.({
              where: {
                itemId: { in: orphanItemIds },
                deletedAt: null,
              },
              data: { deletedAt: now, deletedById: userId },
            }),
            client.attachment?.updateMany?.({
              where: {
                itemId: { in: orphanItemIds },
                deletedAt: null,
              },
              data: { deletedAt: now, deletedById: userId },
            }),
            client.annotation?.updateMany?.({
              where: {
                attachment: { itemId: { in: orphanItemIds } },
                deletedAt: null,
              },
              data: { deletedAt: now },
            }),
          ]);
        }
      }

      await client.libraryCollectionItem?.deleteMany?.({
        where: {
          collectionId:
            targetCollectionIds.length === 1
              ? targetCollectionIds[0]
              : { in: targetCollectionIds },
        },
      });

      const result = await client.libraryCollection.updateMany({
        where: {
          id:
            targetCollectionIds.length === 1
              ? targetCollectionIds[0]
              : { in: targetCollectionIds },
          ...scopeWhere,
          deletedAt: null,
        },
        data: { deletedAt: now, deletedById: userId, version: { increment: 1 } },
      });
      return result.count > 0;
    } else {
      let nextParentId: string | null = null;
      if (strategy === 'move-to-parent' && typeof client.libraryCollection?.findFirst === 'function') {
        const existing = await client.libraryCollection.findFirst({
          where: { id, ...scopeWhere, deletedAt: null },
          select: { parentId: true },
        });
        nextParentId = existing?.parentId ?? null;
      }
      await Promise.all([
        client.libraryCollectionItem?.deleteMany?.({
          where: { collectionId: id },
        }),
        client.libraryCollection.updateMany({
          where: { ...scopeWhere, parentId: id, deletedAt: null },
          data: { parentId: nextParentId, updatedById: userId, version: { increment: 1 } },
        }),
      ]);
    }

    const result = await client.libraryCollection.updateMany({
      where: { id, ...scopeWhere, deletedAt: null },
      data: { deletedAt: now, deletedById: userId, version: { increment: 1 } },
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
    const orderedInputIds = sortLockKeys(itemIds);
    if (orderedInputIds.length === 0) return;
    const client = this.getClient(tx);

    let validItemIds = orderedInputIds;
    if (client.libraryItem?.findMany) {
      const validProjectId = normalizeProjectScopeId(projectId);
      const scopeWhere: Prisma.LibraryItemWhereInput = {
        spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
      };
      const matched = await client.libraryItem.findMany({
        where: {
          ...scopeWhere,
          id: { in: orderedInputIds },
          deletedAt: null,
        },
        select: { id: true },
      });
      validItemIds = sortLockKeys(matched.map((m: { id: string }) => m.id));
    }

    if (validItemIds.length === 0) return;

    await client.libraryCollectionItem.createMany({
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

    await client.libraryCollectionItem.deleteMany({
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
  ): Promise<string[]> {
    if (!itemIds || itemIds.length === 0) return [];
    const client = this.getClient(tx);
    let existingItemIds = itemIds;
    if (typeof client.libraryCollectionItem?.findMany === 'function') {
      const existing = await client.libraryCollectionItem.findMany({
        where: {
          collectionId,
          itemId: { in: itemIds },
        },
        select: { itemId: true },
      });
      if (Array.isArray(existing)) {
        existingItemIds = existing.map((r) => r.itemId);
      }
    }
    if (existingItemIds.length === 0) return [];
    await client.libraryCollectionItem.deleteMany({
      where: {
        collectionId,
        itemId: { in: existingItemIds },
      },
    });
    return existingItemIds;
  }

  /**
   * Moves items to target collection.
   * When `sourceCollectionId` is provided and `targetCollectionId !== null`,
   * only detaches from `sourceCollectionId` so memberships in unrelated collections are preserved.
   * When `targetCollectionId === null` (Unfile) or `sourceCollectionId` is omitted,
   * detaches from all collections in the scope.
   */
  async moveItems(
    userId: string,
    targetCollectionId: string | null,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
    sourceCollectionId?: string | null,
  ): Promise<{ detached: Array<{ collectionId: string; itemId: string }> }> {
    const client = this.getClient(tx);

    const validProjectId = normalizeProjectScopeId(projectId);
    const collectionScope: Prisma.LibraryCollectionWhereInput = {
      spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
    };

    const normalizedSourceId =
      sourceCollectionId &&
      sourceCollectionId !== 'unfiled' &&
      sourceCollectionId !== 'root'
        ? sourceCollectionId
        : null;

    let detached: Array<{ collectionId: string; itemId: string }> = [];

    if (targetCollectionId !== null && normalizedSourceId) {
      if (normalizedSourceId !== targetCollectionId) {
        const detachWhere: Prisma.LibraryCollectionItemWhereInput = {
          itemId: { in: itemIds },
          collectionId: normalizedSourceId,
          collection: collectionScope,
        };
        if (typeof client.libraryCollectionItem?.findMany === 'function') {
          const existing = await client.libraryCollectionItem.findMany({
            where: detachWhere,
            select: { collectionId: true, itemId: true },
          });
          if (Array.isArray(existing)) detached = existing;
        }
        await client.libraryCollectionItem.deleteMany({ where: detachWhere });
      }
    } else {
      const detachWhere: Prisma.LibraryCollectionItemWhereInput = {
        itemId: { in: itemIds },
        collection: collectionScope,
        ...(targetCollectionId ? { collectionId: { not: targetCollectionId } } : {}),
      };
      if (typeof client.libraryCollectionItem?.findMany === 'function') {
        const existing = await client.libraryCollectionItem.findMany({
          where: detachWhere,
          select: { collectionId: true, itemId: true },
        });
        if (Array.isArray(existing)) detached = existing;
      }
      await client.libraryCollectionItem.deleteMany({ where: detachWhere });
    }

    if (targetCollectionId !== null) {
      await this.addItemsToCollection(
        userId,
        targetCollectionId,
        itemIds,
        tx,
        validProjectId,
      );
    }

    return { detached };
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
    const sortedCollections = [...collections].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const runUpdates = async (
      client: Prisma.TransactionClient | PrismaService,
    ) => {
      await Promise.all(
        sortedCollections.map((c) =>
          client.libraryCollection.updateMany({
            where: { id: c.id, ...scopeWhere, deletedAt: null },
            data: {
              ...(c.parentId !== undefined ? { parentId: c.parentId } : {}),
              ...(c.orderIndex !== undefined
                ? { sortOrder: c.orderIndex }
                : {}),
              version: { increment: 1 },
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

    const items = await client.libraryCollectionItem.findMany({
      where: {
        collectionId,
        item: {
          spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
          deletedAt: null,
        },
      },
      select: { itemId: true },
      orderBy: { sortOrder: 'asc' },
      ...(limit !== undefined ? { take: limit } : {}),
    });

    return items.map((i: { itemId: string }) => i.itemId);
  }

  /**
   * Retrieves unique item IDs belonging to multiple collections in a single batched query.
   */
  async findItemIdsByCollections(
    userId: string,
    collectionIds: string[],
    tx?: Prisma.TransactionClient,
    limit?: number,
    projectId?: string,
  ): Promise<string[]> {
    if (!collectionIds || collectionIds.length === 0) return [];
    const client = this.getClient(tx);
    const validProjectId = this.resolveProjectScopeId(projectId);

    const items = await client.libraryCollectionItem.findMany({
      where: {
        collectionId:
          collectionIds.length === 1 ? collectionIds[0] : { in: collectionIds },
        item: {
          spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
          deletedAt: null,
        },
      },
      select: { itemId: true },
      orderBy: { sortOrder: 'asc' },
      ...(limit !== undefined ? { take: limit } : {}),
    });

    return Array.from(new Set(items.map((i: { itemId: string }) => i.itemId)));
  }

  /**
   * Retrieves unique item IDs belonging exclusively to the specified collections (not in any other active collection).
   */
  async findExclusiveItemIdsByCollections(
    userId: string,
    candidateItemIds: string[],
    allCollectionIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<string[]> {
    if (!candidateItemIds || candidateItemIds.length === 0) return [];
    const client = this.getClient(tx);
    if (typeof client.libraryItem?.findMany !== 'function') return [];
    const validProjectId = this.resolveProjectScopeId(projectId);

    const items = await client.libraryItem.findMany({
      where: {
        spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
        id: { in: candidateItemIds },
        deletedAt: null,
        collectionItems: {
          none: {
            collectionId: { notIn: allCollectionIds },
            collection: { deletedAt: null },
          },
        },
      },
      select: { id: true },
    });

    return items.map((i: { id: string }) => i.id);
  }

  async findOwnedItemIds(
    itemIds: string[],
    scopeWhere: Prisma.LibraryItemWhereInput,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = this.getClient(tx);
    if (!client.libraryItem?.findMany) return [];
    const owned = await client.libraryItem.findMany({
      where: { id: { in: itemIds }, ...scopeWhere, deletedAt: null },
      select: { id: true },
    });
    return owned.map((i) => i.id);
  }

  async findValidItemIds(
    itemIds: string[],
    scopeWhere: Prisma.LibraryItemWhereInput,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = this.getClient(tx);
    if (!client.libraryItem?.findMany) return [];
    const valid = await client.libraryItem.findMany({
      where: { id: { in: itemIds }, ...scopeWhere, deletedAt: null },
      select: { id: true },
    });
    return valid.map((i) => i.id);
  }

  async verifyItemInScope(
    itemId: string,
    scopeWhere: Prisma.LibraryItemWhereInput,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    if (!client.libraryItem?.findFirst) return false;
    const item = await client.libraryItem.findFirst({
      where: { id: itemId, ...scopeWhere, deletedAt: null },
      select: { id: true },
    });
    return Boolean(item);
  }
}
