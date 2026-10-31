import { Injectable, Inject, NotFoundException, BadRequestException, UnprocessableEntityException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { CollectionsRepository } from '@/modules/library/catalog/repositories/collections.repository';
import { CreateCollectionDto, UpdateCollectionDto, AssignItemsToCollectionDto, CopyCollectionDto } from '@/modules/library/catalog/dto/collections.dto';
import { CollectionDeleteStrategy, CollectionTreeNode } from '@/modules/library/catalog/types/catalog.types';
import { normalizeParentId, sanitizeCollectionName, sanitizeCollectionDescription } from '@/modules/library/catalog/domain/tree.engine';
import { TreeEngine } from '@/modules/library/catalog/domain/tree.engine';
import { RedisCacheService } from '@/core';
import { normalizeProjectScopeId, isProjectScopeId, LIBRARY_EVENT_TYPES, TransactionHelpers, UNIT_OF_WORK, IUnitOfWork, executeStandardLibraryCacheInvalidation } from '@/modules/library/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { ItemCacheCoordinator } from './item-cache.coordinator';
import {
  validateCollectionReorderNoCycle,
  executeAssignItemsToCollection,
  executeDeleteCollectionWithCascade,
  executeCopyCollectionSubtree,
  transferCollectionItemMembershipsInTx,
} from './collection-membership.helper';
@Injectable()
export class CollectionsService {
  constructor(
    private readonly repo: CollectionsRepository,
    @Optional()
    private readonly tree: TreeEngine = new TreeEngine(),
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx?: IUnitOfWork,
    @Optional() private readonly cacheCoordinator?: ItemCacheCoordinator,
  ) {}
  private resolveValidProjectId(projectId?: string | null): string | undefined {
    const normalized = normalizeProjectScopeId(projectId);
    return isProjectScopeId(normalized) && isUUID(normalized) ? normalized : undefined;
  }
  private async invalidateCollectionsCache(
    userId: string,
    projectId?: string,
    itemIds?: string[],
  ): Promise<void> {
    await executeStandardLibraryCacheInvalidation(
      this.cacheCoordinator,
      this.cache,
      {
        userId,
        projectId: this.resolveValidProjectId(projectId) ?? projectId,
        itemIds,
      },
    );
  }
  async getCollections(userId: string, projectId?: string) {
    const effectiveProjectId = this.resolveValidProjectId(projectId);
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
      const scopeId = effectiveProjectId ? effectiveProjectId : `u:${userId}`;
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
    const effectiveProjectId = this.resolveValidProjectId(projectId);
    const fetchTree = async () => {
      const collections = await this.repo.findAll(userId, effectiveProjectId);
      return { tree: this.tree.buildTree(collections) };
    };
    if (this.cache) {
      const scopeId = effectiveProjectId ? effectiveProjectId : `u:${userId}`;
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
    let ranPostCommitHook = false;
    const collection = this.libraryTx
      ? await this.libraryTx.executeInTransaction(
          async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
            ranPostCommitHook = Boolean(helpers?.onAfterCommit);
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
            helpers?.onAfterCommit?.(() =>
              this.invalidateCollectionsCache(
                userId,
                effectiveProjectId || undefined,
              ),
            );
            return created;
          },
        )
      : await this.repo.create(userId, createPayload);
    if (!ranPostCommitHook) {
      await this.invalidateCollectionsCache(
        userId,
        effectiveProjectId || undefined,
      );
    }
    return { collection };
  }
  private async validateParentNoCycle(
    userId: string,
    collectionId: string,
    rawParentId: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (rawParentId === collectionId) {
      throw new BadRequestException('A collection cannot be its own parent');
    }
    const allCollections = (await this.repo.findAll(userId, projectId, tx)) || [];
    const parentExists = allCollections.some((c) => c.id === rawParentId);
    if (!parentExists) {
      const parent = await this.repo.findById(
        userId,
        rawParentId,
        tx,
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
  async updateCollection(
    userId: string,
    collectionId: string,
    dto: UpdateCollectionDto,
    projectId?: string,
  ) {
    const hasParentIdChange = dto.parentId !== undefined;
    const rawParentId = hasParentIdChange ? normalizeParentId(dto.parentId) : undefined;
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
    const expectedVersion = dto.expectedVersion ?? dto.version;
    let effectiveProjectId = normalizeProjectScopeId(projectId) ?? undefined;
    let ranPostCommitHook = false;
    const collection = this.libraryTx
      ? await this.libraryTx.executeInTransaction(
          async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
            ranPostCommitHook = Boolean(helpers?.onAfterCommit);
            const existing = await this.repo.findById(
              userId,
              collectionId,
              tx,
              projectId,
            );
            if (!existing) {
              throw new NotFoundException(`Collection not found: ${collectionId}`);
            }
            effectiveProjectId =
              normalizeProjectScopeId(projectId ?? existing.projectId) ?? undefined;
            if (hasParentIdChange && rawParentId) {
              await this.validateParentNoCycle(
                userId,
                collectionId,
                rawParentId,
                projectId,
                tx,
              );
            }
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
            helpers?.onAfterCommit?.(() =>
              this.invalidateCollectionsCache(
                userId,
                effectiveProjectId ?? projectId,
              ),
            );
            return updated;
          },
        )
      : await (async () => {
          const existing = await this.repo.findById(
            userId,
            collectionId,
            undefined,
            projectId,
          );
          if (!existing) {
            throw new NotFoundException(`Collection not found: ${collectionId}`);
          }
          effectiveProjectId =
            normalizeProjectScopeId(projectId ?? existing.projectId) ?? undefined;
          if (hasParentIdChange && rawParentId) {
            await this.validateParentNoCycle(
              userId,
              collectionId,
              rawParentId,
              projectId,
            );
          }
          return this.repo.update(
            userId,
            collectionId,
            updatePayload,
            undefined,
            projectId,
            expectedVersion,
          );
        })();
    if (!ranPostCommitHook) {
      await this.invalidateCollectionsCache(userId, effectiveProjectId ?? projectId);
    }
    return { collection };
  }
  async deleteCollection(
    userId: string,
    collectionId: string,
    strategy: CollectionDeleteStrategy = 'orphan',
    projectId?: string,
  ) {
    const { effectiveProjectId, affectedItemIds, ranPostCommitHook } =
      await executeDeleteCollectionWithCascade(
        this.repo,
        this.tree,
        this.libraryTx,
        userId,
        collectionId,
        strategy,
        projectId,
        (effProj, affectedIds) =>
          this.invalidateCollectionsCache(userId, effProj, affectedIds),
      );
    if (!ranPostCommitHook) {
      await this.invalidateCollectionsCache(userId, effectiveProjectId, affectedItemIds);
    }
    return { success: true };
  }
  async moveItems(userId: string, collectionId: string, itemIds: string[], projectId?: string) {
    const destinationCollectionId = collectionId === 'unfiled' ? null : collectionId;
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere = validProjectId ? { projectId: validProjectId } : { userId, projectId: null };
    let ownedItemIds: string[] = [];
    let ranPostCommitHook = false;
    if (this.libraryTx?.executeInTransaction) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          ranPostCommitHook = Boolean(helpers?.onAfterCommit);
          if (collectionId !== 'unfiled') {
            const collection = await this.repo.findById(userId, collectionId, tx, projectId);
            if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
          }
          ownedItemIds = await this.repo.findOwnedItemIds(itemIds, scopeWhere, tx);
          if (ownedItemIds.length === 0) return;
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
          helpers?.onAfterCommit?.(() =>
            this.invalidateCollectionsCache(userId, projectId, ownedItemIds),
          );
        },
      );
    } else {
      if (collectionId !== 'unfiled') {
        const collection = await this.repo.findById(userId, collectionId, undefined, projectId);
        if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
      }
      ownedItemIds = await this.repo.findOwnedItemIds(itemIds, scopeWhere);
      if (ownedItemIds.length === 0) {
        return { message: 'No owned items to move', count: 0, targetCollectionId: destinationCollectionId };
      }
      await this.repo.moveItems(userId, destinationCollectionId, ownedItemIds, undefined, validProjectId);
    }
    if (ownedItemIds.length === 0) {
      return { message: 'No owned items to move', count: 0, targetCollectionId: destinationCollectionId };
    }
    if (!ranPostCommitHook) {
      await this.invalidateCollectionsCache(userId, projectId, ownedItemIds);
    }
    return { message: 'Items moved successfully', count: ownedItemIds.length, targetCollectionId: destinationCollectionId };
  }
  private async validateReorderNoCycle(
    userId: string,
    collections: Array<{ id: string; parentId?: string | null; orderIndex?: number }>,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await validateCollectionReorderNoCycle(
      this.repo,
      this.tree,
      userId,
      collections,
      projectId,
      tx,
    );
  }
  async reorderCollections(
    userId: string,
    collections: Array<{ id: string; parentId?: string | null; orderIndex?: number }>,
    projectId?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(projectId) ?? undefined;

    let updated: Awaited<ReturnType<CollectionsRepository['findAll']>> | undefined;
    let ranPostCommitHook = false;
    if (this.libraryTx?.executeInTransaction) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          ranPostCommitHook = Boolean(helpers?.onAfterCommit);
          await this.validateReorderNoCycle(userId, collections, projectId, tx);
          await this.repo.reorder(userId, collections, projectId, tx);
          const refreshed = (await this.repo.findAll(userId, projectId, tx)) || [];
          updated = refreshed;
          const refreshedMap = new Map(refreshed.map((c) => [c.id, c]));
          const eventScope = { userId, projectId: effectiveProjectId };
          const orderedList = collections || [];
          if (
            orderedList.length > 1 &&
            helpers.appendChangesBatch &&
            helpers.publishOutboxBatch
          ) {
            await helpers.appendChangesBatch(
              eventScope,
              orderedList.map((col) => {
                const updatedCol = refreshedMap.get(col.id);
                return {
                  entityType: 'Collection',
                  entityId: col.id,
                  action: 'update' as const,
                  version: updatedCol?.version ?? 1,
                  data: updatedCol ?? col,
                };
              }),
            );
            await helpers.publishOutboxBatch(
              eventScope,
              orderedList.map((col) => {
                const updatedCol = refreshedMap.get(col.id);
                return {
                  aggregateId: col.id,
                  eventType: LIBRARY_EVENT_TYPES.COLLECTION_UPDATED,
                  payload: updatedCol ?? col,
                };
              }),
            );
          } else {
            for (const col of orderedList) {
              const updatedCol = refreshedMap.get(col.id);
              const actualVersion = updatedCol?.version ?? 1;
              const payload = updatedCol ?? col;
              await helpers.appendChange(eventScope, {
                entityType: 'Collection',
                entityId: col.id,
                action: 'update',
                version: actualVersion,
                data: payload,
              });
              await helpers.publishOutbox(
                eventScope,
                col.id,
                LIBRARY_EVENT_TYPES.COLLECTION_UPDATED,
                payload,
              );
            }
          }
          helpers?.onAfterCommit?.(() =>
            this.invalidateCollectionsCache(userId, projectId),
          );
        },
      );
    } else {
      await this.validateReorderNoCycle(userId, collections, projectId);
      await this.repo.reorder(userId, collections, projectId);
    }

    if (updated === undefined) {
      updated = await this.repo.findAll(userId, projectId);
    }
    if (!ranPostCommitHook) {
      await this.invalidateCollectionsCache(userId, projectId);
    }
    return { collections: updated };
  }
  async assignItemsToCollection(
    userId: string,
    collectionId: string,
    dto: AssignItemsToCollectionDto,
    projectId?: string,
  ) {
    const { ids, count, ranPostCommitHook } = await executeAssignItemsToCollection(
      this.repo,
      this.libraryTx,
      userId,
      collectionId,
      dto,
      projectId,
      (assignedIds) =>
        this.invalidateCollectionsCache(userId, projectId, assignedIds),
    );
    if (count > 0 && !ranPostCommitHook) {
      await this.invalidateCollectionsCache(userId, projectId, ids);
    }
    return { success: true, count };
  }
  async assignItems(
    userId: string,
    collectionId: string,
    dto: AssignItemsToCollectionDto | string[],
    projectId?: string,
  ) {
    const payload = Array.isArray(dto) ? { itemIds: dto } : dto;
    return this.assignItemsToCollection(userId, collectionId, payload, projectId);
  }
  async removeItems(
    userId: string,
    collectionId: string,
    itemIds: string[],
    projectId?: string,
  ) {
    return this.detachItemsFromCollection(userId, collectionId, itemIds, projectId);
  }
  async detachItemFromCollection(
    userId: string,
    collectionId: string,
    itemId: string,
    projectId?: string,
  ) {
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere = validProjectId ? { projectId: validProjectId } : { userId, projectId: null };
    let ranPostCommitHook = false;
    if (this.libraryTx?.executeInTransaction) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          ranPostCommitHook = Boolean(helpers?.onAfterCommit);
          const collection = await this.repo.findById(userId, collectionId, tx, projectId);
          if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
          const itemExists = await this.repo.verifyItemInScope(itemId, scopeWhere, tx);
          if (!itemExists) throw new NotFoundException(`Item not found in library: ${itemId}`);
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
          helpers?.onAfterCommit?.(() =>
            this.invalidateCollectionsCache(userId, projectId, [itemId]),
          );
        },
      );
    } else {
      const collection = await this.repo.findById(userId, collectionId, undefined, projectId);
      if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
      const itemExists = await this.repo.verifyItemInScope(itemId, scopeWhere);
      if (!itemExists) throw new NotFoundException(`Item not found in library: ${itemId}`);
      await this.repo.removeItemFromCollection(userId, collectionId, itemId);
    }
    if (!ranPostCommitHook) {
      await this.invalidateCollectionsCache(userId, projectId, [itemId]);
    }
    return { success: true };
  }
  async detachItemsFromCollection(
    userId: string,
    collectionId: string,
    itemIds: string[],
    projectId?: string,
  ) {
    if (!itemIds || itemIds.length === 0) return { success: true, count: 0 };
    const validProjectId = normalizeProjectScopeId(projectId);
    let ranPostCommitHook = false;
    if (this.libraryTx?.executeInTransaction) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          ranPostCommitHook = Boolean(helpers?.onAfterCommit);
          const collection = await this.repo.findById(userId, collectionId, tx, projectId);
          if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
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
          helpers?.onAfterCommit?.(() =>
            this.invalidateCollectionsCache(userId, projectId, itemIds),
          );
        },
      );
    } else {
      const collection = await this.repo.findById(userId, collectionId, undefined, projectId);
      if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
      await this.repo.removeItems(collectionId, itemIds);
    }
    if (!ranPostCommitHook) {
      await this.invalidateCollectionsCache(userId, projectId, itemIds);
    }
    return { success: true, count: itemIds.length };
  }
  async copyCollection(
    userId: string,
    collectionId: string,
    dto?: CopyCollectionDto,
    projectId?: string,
  ) {
    const {
      collection,
      copiedCount,
      effectiveProjectId,
      affectedItemIds,
      ranPostCommitHook,
    } = await executeCopyCollectionSubtree(
      this.repo,
      this.tree,
      this.libraryTx,
      userId,
      collectionId,
      dto?.parentId,
      projectId,
      (effProj, affectedIds) =>
        this.invalidateCollectionsCache(
          userId,
          effProj ?? projectId,
          affectedIds,
        ),
    );
    if (!ranPostCommitHook) {
      await this.invalidateCollectionsCache(
        userId,
        effectiveProjectId ?? projectId,
        affectedItemIds,
      );
    }
    return { collection, copiedCount };
  }
  async transferItemMemberships(
    sourceItemIds: string[],
    targetItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await transferCollectionItemMembershipsInTx(sourceItemIds, targetItemId, tx);
  }
}
