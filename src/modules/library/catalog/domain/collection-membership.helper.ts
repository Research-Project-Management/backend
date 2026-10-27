import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CollectionsRepository } from '@/modules/library/catalog/repositories/collections.repository';
import { AssignItemsToCollectionDto } from '@/modules/library/catalog/dto/collections.dto';
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
  const collection = await repo.findById(
    userId,
    collectionId,
    undefined,
    projectId,
  );
  if (!collection) {
    throw new NotFoundException(`Collection not found: ${collectionId}`);
  }
  const ids = dto.itemIds || [];
  if (ids.length === 0) return { ids: [], count: 0 };
  const validProjectId = normalizeProjectScopeId(projectId);
  const scopeWhere = validProjectId
    ? { projectId: validProjectId }
    : { userId, projectId: null };
  const validItemIds = await repo.findValidItemIds(ids, scopeWhere);
  const validIdSet = new Set(validItemIds);
  const invalidIds = ids.filter((id) => !validIdSet.has(id));
  if (invalidIds.length > 0) {
    throw new BadRequestException(
      `One or more items do not belong to library: ${invalidIds.join(', ')}`,
    );
  }
  if (libraryTx?.executeInTransaction) {
    await libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
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
  } else {
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
