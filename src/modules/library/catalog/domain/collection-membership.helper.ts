import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CollectionsRepository } from '@/modules/library/catalog/repositories/collections.repository';
import { AssignItemsToCollectionDto } from '@/modules/library/catalog/dto/collections.dto';
import { CollectionDeleteStrategy } from '@/modules/library/catalog/types/collections.types';
import { normalizeParentId } from '@/modules/library/catalog/domain/collections.domain';
import { TreeEngine } from '@/modules/library/catalog/domain/tree.engine';
import {
  normalizeProjectScopeId,
  LIBRARY_EVENT_TYPES,
  TransactionHelpers,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';

export async function validateCollectionReorderNoCycle(
  repo: CollectionsRepository,
  tree: TreeEngine,
  userId: string,
  collections: Array<{
    id: string;
    parentId?: string | null;
    orderIndex?: number;
  }>,
  projectId?: string,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  if (!collections || collections.length === 0) return;
  const allCollections = (await repo.findAll(userId, projectId, tx)) || [];
  if (allCollections.length === 0) return;
  const simulated = allCollections.map((c) => ({ ...c }));
  for (const colUpdate of collections) {
    if (colUpdate.parentId !== undefined) {
      const normalizedParent = normalizeParentId(colUpdate.parentId);
      if (normalizedParent !== null) {
        if (normalizedParent === colUpdate.id) {
          throw new BadRequestException(
            'A collection cannot be its own parent',
          );
        }
        const parentInScope = simulated.some((c) => c.id === normalizedParent);
        if (!parentInScope) {
          const parentRecord = await repo.findById(
            userId,
            normalizedParent,
            tx,
            projectId,
          );
          if (!parentRecord) {
            throw new BadRequestException(
              `Parent collection not found: ${normalizedParent}`,
            );
          }
          simulated.push({ ...parentRecord });
        }
        tree.assertNoCycle(simulated, colUpdate.id, normalizedParent);
      }
      const target = simulated.find((c) => c.id === colUpdate.id);
      if (target) target.parentId = normalizedParent;
    }
  }
}

export async function executeAssignItemsToCollection(
  repo: CollectionsRepository,
  libraryTx: TransactionService | undefined,
  userId: string,
  collectionId: string,
  dto: AssignItemsToCollectionDto,
  projectId?: string,
): Promise<{ ids: string[]; count: number }> {
  const ids = dto.itemIds || [];
  const validProjectId = normalizeProjectScopeId(projectId);
  const scopeWhere = validProjectId
    ? { projectId: validProjectId }
    : { userId, projectId: null };

  const validateInClient = async (tx?: Prisma.TransactionClient) => {
    const collection = await repo.findById(userId, collectionId, tx, projectId);
    if (!collection) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }
    if (ids.length === 0) return false;
    const validItemIds = await repo.findValidItemIds(ids, scopeWhere, tx);
    const validIdSet = new Set(validItemIds);
    const invalidIds = ids.filter((id) => !validIdSet.has(id));
    if (invalidIds.length > 0) {
      throw new BadRequestException(
        `One or more items do not belong to library: ${invalidIds.join(', ')}`,
      );
    }
    return true;
  };

  if (libraryTx?.executeInTransaction) {
    let assigned = false;
    await libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const shouldProceed = await validateInClient(tx);
        if (!shouldProceed) return;
        assigned = true;
        await repo.addItemsToCollection(
          userId,
          collectionId,
          ids,
          tx,
          validProjectId,
        );
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
    if (!assigned) return { ids: [], count: 0 };
  } else {
    const shouldProceed = await validateInClient();
    if (!shouldProceed) return { ids: [], count: 0 };
    await repo.addItemsToCollection(
      userId,
      collectionId,
      ids,
      undefined,
      validProjectId,
    );
  }
  return { ids, count: ids.length };
}

export async function transferCollectionItemMembershipsInTx(
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
      data: sourceItems.map((item) => ({
        itemId: targetItemId,
        collectionId: item.collectionId,
      })),
      skipDuplicates: true,
    });
  }
  await tx.collectionItem.deleteMany({
    where: { itemId: { in: sourceItemIds } },
  });
}

export async function executeDeleteCollectionWithCascade(
  repo: CollectionsRepository,
  tree: TreeEngine,
  libraryTx: TransactionService | undefined,
  userId: string,
  collectionId: string,
  strategy: CollectionDeleteStrategy = 'orphan',
  projectId?: string,
): Promise<{ effectiveProjectId?: string; affectedItemIds: string[] }> {
  const resolveCascadeTargets = async (tx?: Prisma.TransactionClient) => {
    const existing = await repo.findById(userId, collectionId, tx, projectId);
    if (!existing) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }
    const effectiveProjectId =
      normalizeProjectScopeId(projectId ?? existing.projectId) ?? undefined;
    let affectedItemIds = await repo.findItemIdsByCollection(
      userId,
      collectionId,
      tx,
      undefined,
      effectiveProjectId,
    );
    let descendantIds: string[] = [];
    if (strategy === 'cascade') {
      const allCollections = await repo.findAll?.(
        userId,
        effectiveProjectId,
        tx,
      );
      descendantIds = tree.getDescendantIds(allCollections || [], collectionId);
      if (descendantIds.length > 0) {
        const effectiveTx = tx && Object.keys(tx).length > 0 ? tx : undefined;
        const descendantItemLists = repo.findItemIdsByCollections
          ? [
              await repo.findItemIdsByCollections(
                userId,
                descendantIds,
                effectiveTx,
                undefined,
                effectiveProjectId,
              ),
            ]
          : await Promise.all(
              descendantIds.map((descId) =>
                repo.findItemIdsByCollection(
                  userId,
                  descId,
                  effectiveTx,
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
    let deletedItemIds = strategy === 'cascade' ? affectedItemIds : [];
    if (
      strategy === 'cascade' &&
      deletedItemIds.length > 0 &&
      repo.findExclusiveItemIdsByCollections
    ) {
      deletedItemIds = await repo.findExclusiveItemIdsByCollections(
        userId,
        deletedItemIds,
        deletedCollectionIds,
        tx,
        effectiveProjectId,
      );
    }
    return {
      effectiveProjectId,
      affectedItemIds,
      deletedCollectionIds,
      deletedItemIds,
      preResolvedDelete:
        strategy === 'cascade'
          ? {
              targetCollectionIds: deletedCollectionIds,
              itemIds: deletedItemIds,
            }
          : undefined,
    };
  };

  if (libraryTx?.executeInTransaction) {
    return libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const {
          effectiveProjectId,
          affectedItemIds,
          deletedCollectionIds,
          deletedItemIds,
          preResolvedDelete,
        } = await resolveCascadeTargets(tx);
        if (preResolvedDelete) {
          await repo.delete(
            userId,
            collectionId,
            strategy,
            tx,
            projectId,
            preResolvedDelete,
          );
        } else {
          await repo.delete(userId, collectionId, strategy, tx, projectId);
        }
        const eventScope = { userId, projectId: effectiveProjectId };
        if (
          deletedCollectionIds.length > 1 &&
          helpers.recordTombstonesBatch &&
          helpers.appendChangesBatch
        ) {
          const deletedColIso = new Date().toISOString();
          await helpers.recordTombstonesBatch(
            eventScope,
            deletedCollectionIds.map((cId) => ({
              entityType: 'Collection',
              entityId: cId,
            })),
          );
          await helpers.appendChangesBatch(
            eventScope,
            deletedCollectionIds.map((cId) => ({
              entityType: 'Collection',
              entityId: cId,
              action: 'delete',
              version: 0,
              data: { id: cId, deletedAt: deletedColIso },
            })),
          );
        } else {
          for (const cId of deletedCollectionIds) {
            await helpers.recordTombstone(eventScope, {
              entityType: 'Collection',
              entityId: cId,
            });
          }
        }
        if (deletedItemIds.length > 0) {
          const deletedIso = new Date().toISOString();
          await helpers.recordTombstonesBatch(
            eventScope,
            deletedItemIds.map((itId) => ({
              entityType: 'Item',
              entityId: itId,
            })),
          );
          await helpers.appendChangesBatch(
            eventScope,
            deletedItemIds.map((itId) => ({
              entityType: 'Item',
              entityId: itId,
              action: 'delete',
              version: 0,
              data: { id: itId, deletedAt: deletedIso },
            })),
          );
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
        return { effectiveProjectId, affectedItemIds };
      },
    );
  }

  const { effectiveProjectId, affectedItemIds } = await resolveCascadeTargets();
  await repo.delete(userId, collectionId, strategy, undefined, projectId);
  return { effectiveProjectId, affectedItemIds };
}

export async function executeCopyCollectionSubtree(
  repo: CollectionsRepository,
  tree: TreeEngine,
  libraryTx: TransactionService | undefined,
  userId: string,
  collectionId: string,
  targetParentId?: string | null,
  projectId?: string,
): Promise<{
  collection: Awaited<ReturnType<CollectionsRepository['create']>>;
  copiedCount: number;
  effectiveProjectId?: string;
  affectedItemIds: string[];
}> {
  const normalizedTargetParentId = normalizeParentId(targetParentId);

  const runCopy = async (
    tx?: Prisma.TransactionClient,
    helpers?: TransactionHelpers,
  ) => {
    const root = await repo.findById(userId, collectionId, tx, projectId);
    if (!root) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    const effectiveProjectId =
      normalizeProjectScopeId(projectId ?? root.projectId) ?? undefined;
    const allCollections =
      (await repo.findAll(userId, effectiveProjectId, tx)) || [];

    if (normalizedTargetParentId) {
      if (normalizedTargetParentId === collectionId) {
        throw new BadRequestException(
          'Cannot copy collection into itself or its descendants',
        );
      }
      const parentExists =
        allCollections.some((c) => c.id === normalizedTargetParentId) ||
        Boolean(
          await repo.findById(
            userId,
            normalizedTargetParentId,
            tx,
            effectiveProjectId,
          ),
        );
      if (!parentExists) {
        throw new BadRequestException(
          `Target parent collection not found: ${normalizedTargetParentId}`,
        );
      }
      const descendantIds = tree.getDescendantIds(allCollections, collectionId);
      if (descendantIds.includes(normalizedTargetParentId)) {
        throw new BadRequestException(
          'Cannot copy collection into itself or its descendants',
        );
      }
    }

    const childrenByParent = new Map<string, typeof allCollections>();
    for (const col of allCollections) {
      if (col.parentId) {
        const list = childrenByParent.get(col.parentId) ?? [];
        list.push(col);
        childrenByParent.set(col.parentId, list);
      }
    }

    const affectedItemIdSet = new Set<string>();
    let copiedCount = 0;
    const eventScope = { userId, projectId: effectiveProjectId };

    const cloneNode = async (
      source: NonNullable<typeof root> | (typeof allCollections)[number],
      destParentId: string | null,
      isRoot: boolean,
    ): Promise<Awaited<ReturnType<CollectionsRepository['create']>>> => {
      const copyName = isRoot ? `${source.name} (Copy)` : source.name;
      const created = await repo.create(
        userId,
        {
          name: copyName,
          description: source.description ?? undefined,
          color: source.color ?? undefined,
          icon: source.icon ?? undefined,
          parentId: destParentId,
          projectId: effectiveProjectId ?? null,
          createdById: userId,
        },
        tx,
      );
      copiedCount += 1;

      if (helpers) {
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
      }

      const itemIds = await repo.findItemIdsByCollection(
        userId,
        source.id,
        tx,
        undefined,
        effectiveProjectId,
      );
      if (itemIds && itemIds.length > 0) {
        await repo.addItemsToCollection(
          userId,
          created.id,
          itemIds,
          tx,
          effectiveProjectId,
        );
        for (const id of itemIds) {
          affectedItemIdSet.add(id);
        }
        if (helpers) {
          await helpers.appendChange(eventScope, {
            entityType: 'CollectionItem',
            entityId: `${created.id}:${itemIds.join(',')}`,
            action: 'create',
            version: 1,
            data: { collectionId: created.id, itemIds },
          });
          await helpers.publishOutbox(
            eventScope,
            created.id,
            LIBRARY_EVENT_TYPES.COLLECTION_ITEMS_ASSIGNED,
            {
              collectionId: created.id,
              itemIds,
              userId,
              projectId: effectiveProjectId,
            },
          );
        }
      }

      const children = childrenByParent.get(source.id) ?? [];
      for (const child of children) {
        await cloneNode(child, created.id, false);
      }

      return created;
    };

    const rootClone = await cloneNode(root, normalizedTargetParentId, true);
    return {
      collection: rootClone,
      copiedCount,
      effectiveProjectId,
      affectedItemIds: Array.from(affectedItemIdSet),
    };
  };

  if (libraryTx?.executeInTransaction) {
    return libraryTx.executeInTransaction(
      (tx: Prisma.TransactionClient, helpers: TransactionHelpers) =>
        runCopy(tx, helpers),
    );
  }
  return runCopy();
}
