import { Injectable, Inject, NotFoundException, BadRequestException, UnprocessableEntityException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { CollectionsRepository } from '@/modules/library/catalog/repositories/collections.repository';
import { CreateCollectionDto, UpdateCollectionDto, AssignItemsToCollectionDto, CopyCollectionDto } from '@/modules/library/catalog/dto/collections.dto';
import { CollectionDeleteStrategy, CollectionTreeNode } from '@/modules/library/catalog/types/catalog.types';
import { normalizeParentId, sanitizeCollectionName, sanitizeCollectionDescription } from '@/modules/library/catalog/domain/state.domain';
import { TreeEngine } from '@/modules/library/catalog/domain/state.domain';
import { RedisCacheService } from '@/core';
import { normalizeProjectScopeId, isProjectScopeId, libraryConfig, LIBRARY_EVENT_TYPES, TransactionHelpers, UNIT_OF_WORK, IUnitOfWork, executeStandardLibraryCacheInvalidation, SingleFlightCoalescer } from '@/modules/library/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/config/library.config';
import { ItemCacheCoordinator } from './schema-validator.service';
import {
  validateCollectionReorderNoCycle,
  executeAssignItemsToCollection,
  executeDeleteCollectionWithCascade,
  executeCopyCollectionSubtree,
  transferCollectionItemMembershipsInTx,
} from '@/modules/library/catalog/repositories/collection-membership.operations';
@Injectable()
export class CollectionsService {
  private readonly singleFlight = new SingleFlightCoalescer();

  private applyJitter(ttl: number): number {
    return libraryConfig().app.isTest
      ? ttl
      : Math.max(1, Math.floor(ttl * (0.9 + Math.random() * 0.2)));
  }

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
  private async getScopeVersion(scopeId: string): Promise<number> {
    if (!this.cache) return 0;
    try {
      const ver = await this.cache.get<number | string>(
        LIBRARY_REDIS_KEYS.scopeVersion(scopeId),
      );
      return ver !== null && ver !== undefined ? Number(ver) : 0;
    } catch {
      return 0;
    }
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
      const treeNodes = this.tree.buildTree(rawCollections);
      const recursiveCountById = new Map<string, number>();
      const stack: CollectionTreeNode[] = [...treeNodes];
      while (stack.length > 0) {
        const node = stack.pop()!;
        recursiveCountById.set(node.id, node.recursiveItemCount ?? node.itemCount ?? 0);
        for (const child of node.children) {
          stack.push(child);
        }
      }
      const collections = rawCollections.map((c) => {
        const cRecord = c as Record<string, unknown>;
        const count =
          (cRecord.itemCount as number | undefined) ??
          c._count?.collectionItems ??
          0;
        const {
          collectionItems: _collectionItems,
          _count,
          ...rest
        } = c as typeof c & {
          collectionItems?: unknown;
          _count?: { collectionItems?: number };
        };
        return {
          ...rest,
          itemCount: count,
          recursiveItemCount:
            (cRecord.recursiveItemCount as number | undefined) ??
            recursiveCountById.get(c.id) ??
            count,
        };
      });
      return {
        collections,
        total: collections.length,
      };
    };
    const scopeId = effectiveProjectId ? effectiveProjectId : `u:${userId}`;
    const version = await this.getScopeVersion(scopeId);
    const cacheKey = LIBRARY_REDIS_KEYS.collections(scopeId, version);
    return this.singleFlight.execute(cacheKey, () =>
      this.cache
        ? this.cache.wrap(cacheKey, fetchCollections, this.applyJitter(300))
        : fetchCollections(),
    );
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
    const scopeId = effectiveProjectId ? effectiveProjectId : `u:${userId}`;
    const version = await this.getScopeVersion(scopeId);
    const cacheKey = LIBRARY_REDIS_KEYS.collectionTree(scopeId, version);
    return this.singleFlight.execute(cacheKey, () =>
      this.cache
        ? this.cache.wrap(cacheKey, fetchTree, this.applyJitter(300))
        : fetchTree(),
    );
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
    const allCollections =
      (await (this.repo.findAllHierarchyNodes
        ? this.repo.findAllHierarchyNodes(userId, projectId, tx)
        : this.repo.findAll(userId, projectId, tx))) || [];
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
      ...(cleanName !== undefined ? { name: cleanName } : {}),
      ...(cleanDescription !== undefined
        ? { description: cleanDescription }
        : {}),
      ...(dto.color !== undefined ? { color: dto.color } : {}),
      ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
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
            const existingProjId =
              (existing as { projectId?: string | null }).projectId ??
              (existing.spaceId !== existing.createdById ? existing.spaceId : null);
            effectiveProjectId =
              normalizeProjectScopeId(projectId ?? existingProjId) ?? undefined;
            if (hasParentIdChange && rawParentId) {
              if (tx && typeof tx.$queryRaw === 'function') {
                const [firstLock, secondLock] = [collectionId, rawParentId].sort();
                await tx.$queryRaw`SELECT id FROM library_collections WHERE id IN (${firstLock}::uuid, ${secondLock}::uuid) FOR UPDATE`;
              }
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
          const existingProjId =
            (existing as { projectId?: string | null }).projectId ??
            (existing.spaceId !== existing.createdById ? existing.spaceId : null);
          effectiveProjectId =
            normalizeProjectScopeId(projectId ?? existingProjId) ?? undefined;
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
  async moveItems(
    userId: string,
    collectionId: string,
    itemIds: string[],
    projectId?: string,
    sourceCollectionId?: string | null,
  ) {
    const destinationCollectionId = collectionId === 'unfiled' ? null : collectionId;
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.LibraryItemWhereInput = {
      spaceId: validProjectId || userId,
      deletedAt: null,
    };
    let ownedItemIds: string[] = [];
    let ranPostCommitHook = false;
    if (this.libraryTx?.executeInTransaction) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          ranPostCommitHook = Boolean(helpers?.onAfterCommit);
          const [collection, resolvedOwnedIds] = await Promise.all([
            collectionId !== 'unfiled'
              ? this.repo.findById(userId, collectionId, tx, projectId)
              : Promise.resolve(true),
            this.repo.findOwnedItemIds(itemIds, scopeWhere, tx),
          ]);
          if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
          ownedItemIds = resolvedOwnedIds;
          if (ownedItemIds.length === 0) return;
          const moveRes = await this.repo.moveItems(
            userId,
            destinationCollectionId,
            ownedItemIds,
            tx,
            validProjectId,
            sourceCollectionId,
          );
          const detachedLinks = moveRes?.detached ?? [];
          const eventScope = { userId, projectId: validProjectId };
          const eventType =
            destinationCollectionId === null
              ? LIBRARY_EVENT_TYPES.COLLECTION_ITEMS_DETACHED
              : LIBRARY_EVENT_TYPES.COLLECTION_ITEMS_ASSIGNED;
          if (detachedLinks.length > 0) {
            if (helpers.recordTombstonesBatch) {
              await helpers.recordTombstonesBatch(
                eventScope,
                detachedLinks.map((link) => ({
                  entityType: 'CollectionItem',
                  entityId: `${link.collectionId}:${link.itemId}`,
                })),
              );
            } else if (helpers.recordTombstone) {
              for (const link of detachedLinks) {
                await helpers.recordTombstone(eventScope, {
                  entityType: 'CollectionItem',
                  entityId: `${link.collectionId}:${link.itemId}`,
                });
              }
            }
          }
          const changeEntries: Array<{
            entityType: string;
            entityId: string;
            action: 'create' | 'update' | 'delete';
            version: number;
            data: unknown;
          }> = [
            ...detachedLinks.map((link) => ({
              entityType: 'CollectionItem',
              entityId: `${link.collectionId}:${link.itemId}`,
              action: 'delete' as const,
              version: 0,
              data: { collectionId: link.collectionId, itemId: link.itemId },
            })),
            ...(destinationCollectionId !== null
              ? ownedItemIds.map((itemId) => ({
                  entityType: 'CollectionItem',
                  entityId: `${destinationCollectionId}:${itemId}`,
                  action: 'update' as const,
                  version: 1,
                  data: { collectionId: destinationCollectionId, itemId },
                }))
              : []),
          ];
          if (changeEntries.length > 0) {
            if (helpers.appendChangesBatch) {
              await helpers.appendChangesBatch(eventScope, changeEntries);
            } else {
              for (const entry of changeEntries) {
                await helpers.appendChange(eventScope, entry);
              }
            }
          }
          await helpers.publishOutbox(eventScope, destinationCollectionId ?? 'unfiled', eventType, {
            collectionId: destinationCollectionId,
            detachedCollectionIds: Array.from(new Set(detachedLinks.map((l) => l.collectionId))),
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
      const [collection, resolvedOwnedIds] = await Promise.all([
        collectionId !== 'unfiled'
          ? this.repo.findById(userId, collectionId, undefined, projectId)
          : Promise.resolve(true),
        this.repo.findOwnedItemIds(itemIds, scopeWhere),
      ]);
      if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
      ownedItemIds = resolvedOwnedIds;
      if (ownedItemIds.length === 0) {
        return { message: 'No owned items to move', count: 0, targetCollectionId: destinationCollectionId };
      }
      await this.repo.moveItems(
        userId,
        destinationCollectionId,
        ownedItemIds,
        undefined,
        validProjectId,
        sourceCollectionId,
      );
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
    await validateCollectionReorderNoCycle(this.repo, this.tree, userId, collections, projectId, tx);
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
          if (orderedList.length > 1 && helpers.appendChangesBatch && helpers.publishOutboxBatch) {
            await helpers.appendChangesBatch(
              eventScope,
              orderedList.map((col) => {
                const updatedCol = refreshedMap.get(col.id) as { version?: number } | undefined;
                return { entityType: 'Collection', entityId: col.id, action: 'update' as const, version: updatedCol?.version ?? 1, data: updatedCol ?? col };
              }),
            );
            await helpers.publishOutboxBatch(
              eventScope,
              orderedList.map((col) => {
                const updatedCol = refreshedMap.get(col.id);
                return { aggregateId: col.id, eventType: LIBRARY_EVENT_TYPES.COLLECTION_UPDATED, payload: updatedCol ?? col };
              }),
            );
          } else {
            for (const col of orderedList) {
              const updatedCol = refreshedMap.get(col.id) as { version?: number } | undefined;
              const payload = updatedCol ?? col;
              await helpers.appendChange(eventScope, { entityType: 'Collection', entityId: col.id, action: 'update', version: updatedCol?.version ?? 1, data: payload });
              await helpers.publishOutbox(eventScope, col.id, LIBRARY_EVENT_TYPES.COLLECTION_UPDATED, payload);
            }
          }
          helpers?.onAfterCommit?.(() => this.invalidateCollectionsCache(userId, projectId));
        },
      );
    } else {
      await this.validateReorderNoCycle(userId, collections, projectId);
      await this.repo.reorder(userId, collections, projectId);
    }
    if (updated === undefined) updated = await this.repo.findAll(userId, projectId);
    if (!ranPostCommitHook) await this.invalidateCollectionsCache(userId, projectId);
    return { collections: updated };
  }
  async assignItemsToCollection(userId: string, collectionId: string, dto: AssignItemsToCollectionDto, projectId?: string) {
    const { ids, count, ranPostCommitHook } = await executeAssignItemsToCollection(
      this.repo, this.libraryTx, userId, collectionId, dto, projectId,
      (assignedIds) => this.invalidateCollectionsCache(userId, projectId, assignedIds),
    );
    if (count > 0 && !ranPostCommitHook) await this.invalidateCollectionsCache(userId, projectId, ids);
    return { success: true, count };
  }
  async detachItemFromCollection(userId: string, collectionId: string, itemId: string, projectId?: string) {
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.LibraryItemWhereInput = { spaceId: validProjectId || userId };
    let ranPostCommitHook = false;
    if (this.libraryTx?.executeInTransaction) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          ranPostCommitHook = Boolean(helpers?.onAfterCommit);
          const [collection, itemExists] = await Promise.all([
            this.repo.findById(userId, collectionId, tx, projectId),
            this.repo.verifyItemInScope(itemId, scopeWhere, tx),
          ]);
          if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
          if (!itemExists) throw new NotFoundException(`Item not found in library: ${itemId}`);
          await this.repo.removeItemFromCollection(userId, collectionId, itemId, tx);
          const eventScope = { userId, projectId: validProjectId };
          await helpers.recordTombstone(eventScope, { entityType: 'CollectionItem', entityId: `${collectionId}:${itemId}` });
          await helpers.appendChange(eventScope, { entityType: 'CollectionItem', entityId: `${collectionId}:${itemId}`, action: 'delete', version: 0, data: { collectionId, itemId } });
          await helpers.publishOutbox(eventScope, collectionId, LIBRARY_EVENT_TYPES.COLLECTION_ITEMS_DETACHED, { collectionId, itemIds: [itemId], itemId, userId, projectId: validProjectId });
          helpers?.onAfterCommit?.(() => this.invalidateCollectionsCache(userId, projectId, [itemId]));
        },
      );
    } else {
      const [collection, itemExists] = await Promise.all([
        this.repo.findById(userId, collectionId, undefined, projectId),
        this.repo.verifyItemInScope(itemId, scopeWhere),
      ]);
      if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
      if (!itemExists) throw new NotFoundException(`Item not found in library: ${itemId}`);
      await this.repo.removeItemFromCollection(userId, collectionId, itemId);
    }
    if (!ranPostCommitHook) await this.invalidateCollectionsCache(userId, projectId, [itemId]);
    return { success: true };
  }
  async detachItemsFromCollection(userId: string, collectionId: string, itemIds: string[], projectId?: string) {
    if (!itemIds || itemIds.length === 0) return { success: true, count: 0 };
    const validProjectId = normalizeProjectScopeId(projectId);
    let ranPostCommitHook = false;
    let removedIds: string[] = [];
    if (this.libraryTx?.executeInTransaction) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          ranPostCommitHook = Boolean(helpers?.onAfterCommit);
          const collection = await this.repo.findById(userId, collectionId, tx, projectId);
          if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
          const res = await this.repo.removeItems(collectionId, itemIds, tx);
          removedIds = Array.isArray(res) ? res : itemIds;
          if (removedIds.length === 0) return;
          const eventScope = { userId, projectId: validProjectId };
          if (helpers.recordTombstonesBatch) {
            await helpers.recordTombstonesBatch(eventScope, removedIds.map((itemId) => ({ entityType: 'CollectionItem', entityId: `${collectionId}:${itemId}` })));
          } else {
            for (const itemId of removedIds) await helpers.recordTombstone(eventScope, { entityType: 'CollectionItem', entityId: `${collectionId}:${itemId}` });
          }
          if (helpers.appendChangesBatch) {
            await helpers.appendChangesBatch(eventScope, removedIds.map((itemId) => ({ entityType: 'CollectionItem', entityId: `${collectionId}:${itemId}`, action: 'delete' as const, version: 0, data: { collectionId, itemId } })));
          } else {
            for (const itemId of removedIds) await helpers.appendChange(eventScope, { entityType: 'CollectionItem', entityId: `${collectionId}:${itemId}`, action: 'delete', version: 0, data: { collectionId, itemId } });
          }
          await helpers.publishOutbox(eventScope, collectionId, LIBRARY_EVENT_TYPES.COLLECTION_ITEMS_DETACHED, { collectionId, itemIds: removedIds, userId, projectId: validProjectId });
          helpers?.onAfterCommit?.(() => this.invalidateCollectionsCache(userId, projectId, removedIds));
        },
      );
    } else {
      const collection = await this.repo.findById(userId, collectionId, undefined, projectId);
      if (!collection) throw new NotFoundException(`Collection not found: ${collectionId}`);
      const res = await this.repo.removeItems(collectionId, itemIds);
      removedIds = Array.isArray(res) ? res : itemIds;
    }
    if (removedIds.length > 0 && !ranPostCommitHook) await this.invalidateCollectionsCache(userId, projectId, removedIds);
    return { success: true, count: removedIds.length };
  }
  async copyCollection(userId: string, collectionId: string, dto?: CopyCollectionDto, projectId?: string) {
    const { collection, copiedCount, effectiveProjectId, affectedItemIds, ranPostCommitHook } = await executeCopyCollectionSubtree(
      this.repo, this.tree, this.libraryTx, userId, collectionId, dto?.parentId, projectId,
      (effProj, affectedIds) => this.invalidateCollectionsCache(userId, effProj ?? projectId, affectedIds),
    );
    if (!ranPostCommitHook) await this.invalidateCollectionsCache(userId, effectiveProjectId ?? projectId, affectedItemIds);
    return { collection, copiedCount };
  }
  async transferItemMemberships(sourceItemIds: string[], targetItemId: string, tx: Prisma.TransactionClient): Promise<void> {
    await transferCollectionItemMembershipsInTx(sourceItemIds, targetItemId, tx);
  }
}
