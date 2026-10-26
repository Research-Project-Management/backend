import { Injectable, NotFoundException, BadRequestException, UnprocessableEntityException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CollectionsRepository } from '@/modules/library/catalog/repositories/collections.repository';
import { CreateCollectionDto, UpdateCollectionDto, AssignItemsToCollectionDto } from '@/modules/library/catalog/dto/collections.dto';
import { CollectionDeleteStrategy, CollectionTreeNode } from '@/modules/library/catalog/types/collections.types';
import { normalizeParentId, sanitizeCollectionName, sanitizeCollectionDescription } from '@/modules/library/catalog/domain/collections.domain';
import { TreeEngine } from '@/modules/library/catalog/domain/tree.engine';
import { RedisCacheService } from '@/core';
import { normalizeProjectScopeId, LIBRARY_EVENT_TYPES, TransactionHelpers } from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { ItemCacheCoordinator } from './item-cache.coordinator';
@Injectable()
export class CollectionsService {
  constructor(
    private readonly repo: CollectionsRepository,
    @Optional()
    private readonly tree: TreeEngine = new TreeEngine(),
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly libraryTx?: TransactionService,
    @Optional() private readonly cacheCoordinator?: ItemCacheCoordinator,
  ) {}
  private async invalidateCollectionsCache(
    userId: string,
    projectId?: string,
    itemIds?: string[],
  ): Promise<void> {
    if (this.cacheCoordinator) {
      await this.cacheCoordinator.invalidateForWrite({
        userId,
        projectId,
        itemIds,
      });
    }
    if (!this.cache) return;
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const scopeId = effectiveProjectId ? `proj:${effectiveProjectId}` : userId;
    await Promise.all([
      this.cache.delPattern(LIBRARY_REDIS_KEYS.collectionsPattern(userId)),
      this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
      this.cache.delPattern(LIBRARY_REDIS_KEYS.countsPattern(userId)),
      this.cache.delPattern(LIBRARY_REDIS_KEYS.searchFacetsPattern(userId)),
      this.cache.delPattern(LIBRARY_REDIS_KEYS.searchItemsPattern(userId)),
      this.cache.del(LIBRARY_REDIS_KEYS.searchVersion(userId)),
      ...(effectiveProjectId
        ? [
            this.cache.delPattern(LIBRARY_REDIS_KEYS.collectionsPattern(effectiveProjectId)),
            this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(scopeId)),
            this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(effectiveProjectId)),
            this.cache.delPattern(LIBRARY_REDIS_KEYS.countsPattern(effectiveProjectId)),
            this.cache.delPattern(LIBRARY_REDIS_KEYS.searchFacetsPattern(effectiveProjectId)),
            this.cache.delPattern(LIBRARY_REDIS_KEYS.searchItemsPattern(effectiveProjectId)),
            this.cache.del(LIBRARY_REDIS_KEYS.searchVersion(effectiveProjectId)),
            this.cache.del(LIBRARY_REDIS_KEYS.searchVersion(scopeId)),
          ]
        : []),
      ...(itemIds && itemIds.length > 0
        ? Array.from(new Set(itemIds)).flatMap((id) => [
            this.cache!.del(LIBRARY_REDIS_KEYS.item(id)),
            this.cache!.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
            this.cache!.delPattern(LIBRARY_REDIS_KEYS.itemPattern(id)),
          ])
        : []),
    ]);
  }
  async getCollections(userId: string, projectId?: string) {
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const fetchCollections = async () => {
      const rawCollections = await this.repo.findAll(
        userId,
        effectiveProjectId,
      );
      const collections = rawCollections.map((c) => {
        const cRecord = c as Record<string, unknown>;
        const count = c._count?.collectionItems ?? 0;
        return {
          ...c,
          itemCount: (cRecord.itemCount as number | undefined) ?? count,
        };
      });
      return {
        collections,
        total: collections.length,
      };
    };
    if (this.cache) {
      const scopeId = effectiveProjectId || userId;
      return this.cache.wrap(
        LIBRARY_REDIS_KEYS.collections(scopeId),
        fetchCollections,
        300,
      );
    }
    return fetchCollections();
  }
  async getCollectionTree(
    userId: string,
    projectId?: string,
  ): Promise<{ tree: CollectionTreeNode[] }> {
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const fetchTree = async () => {
      const collections = await this.repo.findAll(userId, effectiveProjectId);
      return { tree: this.tree.buildTree(collections) };
    };
    if (this.cache) {
      const scopeId = effectiveProjectId || userId;
      return this.cache.wrap(
        LIBRARY_REDIS_KEYS.collectionTree(scopeId),
        fetchTree,
        300,
      );
    }
    return fetchTree();
  }
  async getCollectionById(
    userId: string,
    collectionId: string,
    projectId?: string,
  ) {
    const raw = await this.repo.findById(
      userId,
      collectionId,
      undefined,
      projectId,
    );
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
    };
    return { collection };
  }
  async createCollection(
    userId: string,
    dto: CreateCollectionDto,
    projectId?: string,
  ) {
    const effectiveProjectId =
      normalizeProjectScopeId(projectId || dto.projectId) ?? null;
    const rawParentId = normalizeParentId(dto.parentId);
    if (rawParentId) {
      const parent = await this.repo.findById(
        userId,
        rawParentId,
        undefined,
        effectiveProjectId || undefined,
      );
      if (!parent) {
        throw new BadRequestException(
          `Parent collection not found: ${rawParentId}`,
        );
      }
    }
    const cleanName = sanitizeCollectionName(dto.name);
    if (!cleanName) {
      throw new UnprocessableEntityException('Collection name cannot be empty');
    }
    const cleanDescription =
      dto.description !== undefined
        ? sanitizeCollectionDescription(dto.description)
        : undefined;
    const createPayload = {
      name: cleanName,
      description: cleanDescription,
      color: dto.color,
      icon: dto.icon,
      parentId: rawParentId,
      projectId: effectiveProjectId,
      createdById: userId,
    };
    const collection = this.libraryTx
      ? await this.libraryTx.executeInTransaction(
          async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
            const created = await this.repo.create(userId, createPayload, tx);
            const eventScope = {
              userId,
              projectId: effectiveProjectId || undefined,
            };
            await helpers.appendChange(eventScope, {
              entityType: 'Collection',
              entityId: created.id,
              action: 'create',
              version: created.version ?? 1,
              data: created,
            });
            await helpers.publishOutbox(
              eventScope,
              created.id,
              LIBRARY_EVENT_TYPES.COLLECTION_CREATED,
              created,
            );
            return created;
          },
        )
      : await this.repo.create(userId, createPayload);
    await this.invalidateCollectionsCache(
      userId,
      effectiveProjectId || undefined,
    );
    return { collection };
  }
  async updateCollection(
    userId: string,
    collectionId: string,
    dto: UpdateCollectionDto,
    projectId?: string,
  ) {
    const existing = await this.repo.findById(
      userId,
      collectionId,
      undefined,
      projectId,
    );
    if (!existing) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }
    const hasParentIdChange = dto.parentId !== undefined;
    const rawParentId = hasParentIdChange ? normalizeParentId(dto.parentId) : undefined;
    if (hasParentIdChange && rawParentId) {
      if (rawParentId === collectionId) {
        throw new BadRequestException('A collection cannot be its own parent');
      }
      const allCollections = await this.repo.findAll(userId, projectId);
      const parentExists = allCollections.some((c) => c.id === rawParentId);
      if (!parentExists) {
        const parent = await this.repo.findById(
          userId,
          rawParentId,
          undefined,
          projectId,
        );
        if (!parent) {
          throw new BadRequestException(
            `Parent collection not found: ${rawParentId}`,
          );
        }
      }
      this.tree.assertNoCycle(allCollections, collectionId, rawParentId);
    }
    let cleanName: string | undefined = undefined;
    if (dto.name !== undefined) {
      cleanName = sanitizeCollectionName(dto.name);
      if (!cleanName) {
        throw new UnprocessableEntityException(
          'Collection name cannot be empty',
        );
      }
    }
    const cleanDescription =
      dto.description !== undefined
        ? sanitizeCollectionDescription(dto.description)
        : undefined;
    const updatePayload = {
      ...dto,
      ...(cleanName !== undefined ? { name: cleanName } : {}),
      ...(cleanDescription !== undefined
        ? { description: cleanDescription }
        : {}),
      ...(hasParentIdChange ? { parentId: rawParentId } : {}),
    };
    const effectiveProjectId =
      normalizeProjectScopeId(projectId ?? existing.projectId) ?? undefined;
    const expectedVersion = dto.expectedVersion ?? dto.version;
    const collection = this.libraryTx
      ? await this.libraryTx.executeInTransaction(
          async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
            const updated = await this.repo.update(
              userId,
              collectionId,
              updatePayload,
              tx,
              projectId,
              expectedVersion,
            );
            const eventScope = { userId, projectId: effectiveProjectId };
            await helpers.appendChange(eventScope, {
              entityType: 'Collection',
              entityId: collectionId,
              action: 'update',
              version: updated.version ?? 1,
              data: updated,
            });
            await helpers.publishOutbox(
              eventScope,
              collectionId,
              LIBRARY_EVENT_TYPES.COLLECTION_UPDATED,
              updated,
            );
            return updated;
          },
        )
      : await this.repo.update(
          userId,
          collectionId,
          updatePayload,
          undefined,
          projectId,
          expectedVersion,
        );
    await this.invalidateCollectionsCache(userId, projectId);
    return { collection };
  }
  async deleteCollection(
    userId: string,
    collectionId: string,
    strategy: CollectionDeleteStrategy = 'orphan',
    projectId?: string,
  ) {
    const existing = await this.repo.findById(
      userId,
      collectionId,
      undefined,
      projectId,
    );
    if (!existing) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }
    const effectiveProjectId =
      normalizeProjectScopeId(projectId ?? existing.projectId) ?? undefined;
    let affectedItemIds = await this.repo.findItemIdsByCollection(
      userId,
      collectionId,
      undefined,
      undefined,
      effectiveProjectId,
    );
    let descendantIds: string[] = [];
    if (strategy === 'cascade') {
      const allCollections = await this.repo.findAll?.(
        userId,
        effectiveProjectId,
      );
      descendantIds = this.tree.getDescendantIds(
        allCollections || [],
        collectionId,
      );
      if (descendantIds.length > 0) {
        const descendantItemLists = this.repo.findItemIdsByCollections
          ? [await this.repo.findItemIdsByCollections(userId, descendantIds, undefined, undefined, effectiveProjectId)]
          : await Promise.all(
          descendantIds.map((descId) =>
            this.repo.findItemIdsByCollection(
              userId,
              descId,
              undefined,
              undefined,
              effectiveProjectId,
            ),
          ),
        );
        affectedItemIds = Array.from(
          new Set([...affectedItemIds, ...descendantItemLists.flat()]),
        );
      }
    }
    const deletedCollectionIds =
      strategy === 'cascade' && descendantIds.length > 0
        ? Array.from(new Set([collectionId, ...descendantIds]))
        : [collectionId];
    const deletedItemIds = strategy === 'cascade' ? affectedItemIds : [];
    const preResolvedDelete =
      strategy === 'cascade'
        ? {
            targetCollectionIds: deletedCollectionIds,
            itemIds: deletedItemIds,
          }
        : undefined;
    if (typeof this.libraryTx?.executeInTransaction === 'function') {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          if (preResolvedDelete) { await this.repo.delete(userId, collectionId, strategy, tx, projectId, preResolvedDelete); } else { await this.repo.delete(userId, collectionId, strategy, tx, projectId); }
          const eventScope = { userId, projectId: effectiveProjectId };
          if (deletedCollectionIds.length > 1 && helpers.recordTombstonesBatch && helpers.appendChangesBatch) {
            const deletedColIso = new Date().toISOString();
            await helpers.recordTombstonesBatch(eventScope, deletedCollectionIds.map((cId) => ({ entityType: 'Collection', entityId: cId })));
            await helpers.appendChangesBatch(eventScope, deletedCollectionIds.map((cId) => ({ entityType: 'Collection', entityId: cId, action: 'delete', version: 0, data: { id: cId, deletedAt: deletedColIso } })));
          } else for (const cId of deletedCollectionIds) {
            await helpers.recordTombstone(eventScope, {
              entityType: 'Collection',
              entityId: cId,
            });
            await helpers.appendChange(eventScope, {
              entityType: 'Collection',
              entityId: cId,
              action: 'delete',
              version: 0,
              data: { id: cId, deletedAt: new Date().toISOString() },
            });
          }
          if (deletedItemIds.length > 0) {
            const deletedIso = new Date().toISOString();
            await helpers.recordTombstonesBatch(eventScope, deletedItemIds.map((itId) => ({ entityType: 'Item', entityId: itId })));
            await helpers.appendChangesBatch(eventScope, deletedItemIds.map((itId) => ({ entityType: 'Item', entityId: itId, action: 'delete', version: 0, data: { id: itId, deletedAt: deletedIso } })));
            if (helpers.publishOutboxBatch) {
              await helpers.publishOutboxBatch(
                eventScope,
                deletedItemIds.map((itId) => ({
                  aggregateId: itId,
                  eventType: LIBRARY_EVENT_TYPES.ITEM_DELETED,
                  payload: {
                    id: itId,
                    itemId: itId,
                    deletedAt: deletedIso,
                    projectId: effectiveProjectId,
                  },
                })),
              );
            } else {
              for (const itId of deletedItemIds) {
                await helpers.publishOutbox(
                  eventScope,
                  itId,
                  LIBRARY_EVENT_TYPES.ITEM_DELETED,
                  {
                    id: itId,
                    itemId: itId,
                    deletedAt: deletedIso,
                    projectId: effectiveProjectId,
                  },
                );
              }
            }
          }
          await helpers.publishOutbox(
            eventScope,
            collectionId,
            LIBRARY_EVENT_TYPES.COLLECTION_DELETED,
            {
              id: collectionId,
              strategy,
              deletedAt: new Date(),
              projectId: effectiveProjectId,
              deletedCollectionIds,
              deletedItemIds,
            },
          );
        },
      );
    } else {
      await this.repo.delete(userId, collectionId, strategy, undefined, projectId);
    }
    await this.invalidateCollectionsCache(
      userId,
      effectiveProjectId,
      affectedItemIds,
    );
    return { success: true };
  }
  async moveItems(
    userId: string,
    collectionId: string,
    itemIds: string[],
    projectId?: string,
  ) {
    if (collectionId !== 'unfiled') {
      const collection = await this.repo.findById(
        userId,
        collectionId,
        undefined,
        projectId,
      );
      if (!collection) {
        throw new NotFoundException(`Collection not found: ${collectionId}`);
      }
    }
    const destinationCollectionId =
      collectionId === 'unfiled' ? null : collectionId;
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere = validProjectId
      ? { projectId: validProjectId }
      : { userId, projectId: null };
    const ownedItemIds = await this.repo.findOwnedItemIds(itemIds, scopeWhere);
    if (ownedItemIds.length === 0) {
      return {
        message: 'No owned items to move',
        count: 0,
        targetCollectionId: destinationCollectionId,
      };
    }
    if (typeof this.libraryTx?.executeInTransaction === 'function') {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          await this.repo.moveItems(userId, destinationCollectionId, ownedItemIds, tx, validProjectId);
          const eventScope = { userId, projectId: validProjectId };
          const eventType =
            destinationCollectionId === null
              ? LIBRARY_EVENT_TYPES.COLLECTION_ITEMS_DETACHED
              : LIBRARY_EVENT_TYPES.COLLECTION_ITEMS_ASSIGNED;
          await helpers.appendChange(eventScope, {
            entityType: 'CollectionItem',
            entityId: `${collectionId}:${ownedItemIds.join(',')}`,
            action: destinationCollectionId === null ? 'delete' : 'update',
            version: 1,
            data: { collectionId: destinationCollectionId, itemIds: ownedItemIds },
          });
          await helpers.publishOutbox(eventScope, collectionId, eventType, {
            collectionId: destinationCollectionId,
            itemIds: ownedItemIds,
            userId,
            projectId: validProjectId,
          });
        },
      );
    } else {
      await this.repo.moveItems(userId, destinationCollectionId, ownedItemIds, undefined, validProjectId);
    }
    await this.invalidateCollectionsCache(userId, projectId, ownedItemIds);
    return {
      message: 'Items moved successfully',
      count: ownedItemIds.length,
      targetCollectionId: destinationCollectionId,
    };
  }
  async reorderCollections(
    userId: string,
    collections: Array<{ id: string; parentId?: string | null; orderIndex?: number }>,
    projectId?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(projectId) ?? undefined;
    const allCollections = (await this.repo.findAll(userId, projectId)) || [];

    if (collections && collections.length > 0 && allCollections.length > 0) {
      const simulated = allCollections.map((c) => ({ ...c }));
      for (const colUpdate of collections) {
        if (colUpdate.parentId !== undefined) {
          const normalizedParent = normalizeParentId(colUpdate.parentId);
          if (normalizedParent !== null) {
            if (normalizedParent === colUpdate.id) {
              throw new BadRequestException('A collection cannot be its own parent');
            }
            const parentInScope = simulated.some((c) => c.id === normalizedParent);
            if (!parentInScope) {
              const parentRecord = await this.repo.findById(userId, normalizedParent, undefined, projectId);
              if (!parentRecord) {
                throw new BadRequestException(`Parent collection not found: ${normalizedParent}`);
              }
              simulated.push({ ...parentRecord });
            }
            this.tree.assertNoCycle(simulated, colUpdate.id, normalizedParent);
          }
          const target = simulated.find((c) => c.id === colUpdate.id);
          if (target) target.parentId = normalizedParent;
        }
      }
    }

    if (typeof this.libraryTx?.executeInTransaction === 'function') {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          await this.repo.reorder(userId, collections, projectId, tx);
          const eventScope = { userId, projectId: effectiveProjectId };
          for (const col of collections || []) {
            await helpers.appendChange(eventScope, {
              entityType: 'Collection',
              entityId: col.id,
              action: 'update',
              version: 1,
              data: col,
            });
            await helpers.publishOutbox(
              eventScope,
              col.id,
              LIBRARY_EVENT_TYPES.COLLECTION_UPDATED,
              col,
            );
          }
        },
      );
    } else {
      await this.repo.reorder(userId, collections, projectId);
    }

    const updated = await this.repo.findAll(userId, projectId);
    await this.invalidateCollectionsCache(userId, projectId);
    return { collections: updated };
  }
  async assignItemsToCollection(
    userId: string,
    collectionId: string,
    dto: AssignItemsToCollectionDto,
    projectId?: string,
  ) {
    const collection = await this.repo.findById(
      userId,
      collectionId,
      undefined,
      projectId,
    );
    if (!collection) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }
    const ids = dto.itemIds || [];
    if (ids.length === 0) {
      return { success: true, count: 0 };
    }
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere = validProjectId
      ? { projectId: validProjectId }
      : { userId, projectId: null };
    const validItemIds = await this.repo.findValidItemIds(ids, scopeWhere);
    const validIdSet = new Set(validItemIds);
    const invalidIds = ids.filter((id) => !validIdSet.has(id));
    if (invalidIds.length > 0) {
      throw new BadRequestException(
        `One or more items do not belong to library: ${invalidIds.join(', ')}`,
      );
    }
    if (typeof this.libraryTx?.executeInTransaction === 'function') {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          await this.repo.addItemsToCollection(userId, collectionId, ids, tx, validProjectId);
          const eventScope = { userId, projectId: validProjectId };
          await helpers.appendChange(eventScope, {
            entityType: 'CollectionItem',
            entityId: `${collectionId}:${ids.join(',')}`,
            action: 'create',
            version: 1,
            data: { collectionId, itemIds: ids },
          });
          await helpers.publishOutbox(
            eventScope,
            collectionId,
            LIBRARY_EVENT_TYPES.COLLECTION_ITEMS_ASSIGNED,
            {
              collectionId,
              itemIds: ids,
              userId,
              projectId: validProjectId,
            },
          );
        },
      );
    } else {
      await this.repo.addItemsToCollection(userId, collectionId, ids, undefined, validProjectId);
    }
    await this.invalidateCollectionsCache(userId, projectId, ids);
    return { success: true, count: ids.length };
  }
  async detachItemFromCollection(
    userId: string,
    collectionId: string,
    itemId: string,
    projectId?: string,
  ) {
    const collection = await this.repo.findById(userId, collectionId, undefined, projectId);
    if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere = validProjectId ? { projectId: validProjectId } : { userId, projectId: null };
    const itemExists = await this.repo.verifyItemInScope(itemId, scopeWhere);
    if (!itemExists) throw new NotFoundException(`Item not found in library: ${itemId}`);
    if (typeof this.libraryTx?.executeInTransaction === 'function') {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          await this.repo.removeItemFromCollection(userId, collectionId, itemId, tx);
          const eventScope = { userId, projectId: validProjectId };
          await helpers.recordTombstone(eventScope, {
            entityType: 'CollectionItem',
            entityId: `${collectionId}:${itemId}`,
          });
          await helpers.publishOutbox(
            eventScope,
            collectionId,
            LIBRARY_EVENT_TYPES.COLLECTION_ITEMS_DETACHED,
            { collectionId, itemIds: [itemId], itemId, userId, projectId: validProjectId },
          );
        },
      );
    } else {
      await this.repo.removeItemFromCollection(userId, collectionId, itemId);
    }
    await this.invalidateCollectionsCache(userId, projectId, [itemId]);
    return { success: true };
  }
  async detachItemsFromCollection(
    userId: string,
    collectionId: string,
    itemIds: string[],
    projectId?: string,
  ) {
    if (!itemIds || itemIds.length === 0) return { success: true, count: 0 };
    const collection = await this.repo.findById(userId, collectionId, undefined, projectId);
    if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
    const validProjectId = normalizeProjectScopeId(projectId);
    if (typeof this.libraryTx?.executeInTransaction === 'function') {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          await this.repo.removeItems(collectionId, itemIds, tx);
          const eventScope = { userId, projectId: validProjectId };
          await helpers.recordTombstone(eventScope, {
            entityType: 'CollectionItem',
            entityId: `${collectionId}:${itemIds.join(',')}`,
          });
          await helpers.publishOutbox(
            eventScope,
            collectionId,
            LIBRARY_EVENT_TYPES.COLLECTION_ITEMS_DETACHED,
            { collectionId, itemIds, userId, projectId: validProjectId },
          );
        },
      );
    } else {
      await this.repo.removeItems(collectionId, itemIds);
    }
    await this.invalidateCollectionsCache(userId, projectId, itemIds);
    return { success: true, count: itemIds.length };
  }
  async transferItemMemberships(
    sourceItemIds: string[],
    targetItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;
    const sourceItems = await tx.collectionItem.findMany({
      where: { itemId: { in: sourceItemIds } },
      select: { collectionId: true },
    });
    if (sourceItems.length > 0) {
      await tx.collectionItem.createMany({
        data: sourceItems.map((item) => ({ itemId: targetItemId, collectionId: item.collectionId })),
        skipDuplicates: true,
      });
    }
    await tx.collectionItem.deleteMany({ where: { itemId: { in: sourceItemIds } } });
  }
}
