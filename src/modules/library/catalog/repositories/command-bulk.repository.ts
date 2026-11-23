import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  extractFileIdFromUrl,
  normalizeProjectSpaceId,
  resolveSpaceId,
  LIBRARY_EVENT_TYPES,
  TransactionHelpers,
  ItemsMapper,
  isUuid,
} from '@/modules/library/core';

export interface ICommandBulkRepositoryPort {
  softDeleteMany(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<{ succeededIds: string[]; failedIds: string[] }>;
  restoreMany(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<{
    restoredItems: Array<{
      id: string;
      version: number;
      projectId: string | null;
    }>;
    succeededIds: string[];
    failedIds: string[];
  }>;
  purgeMany(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<{
    succeededIds: string[];
    failedIds: string[];
    fileIdsToDelete: string[];
    storagePaths: string[];
  }>;
  emptyTrash(
    userId: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<{
    succeededIds: string[];
    failedIds: string[];
    fileIdsToDelete: string[];
    storagePaths: string[];
  }>;
  purgeExpiredTrash(
    retentionDays?: number,
    limit?: number,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    purgedItems: number;
    purgedNotes: number;
    purgedCollections: number;
    storagePaths: string[];
    storageDeletes?: Array<{ fileId: string; spaceId?: string }>;
    expiredItems: Array<{
      id: string;
      userId: string;
      projectId: string | null;
    }>;
    expiredNotes: Array<{
      id: string;
      userId: string;
      projectId: string | null;
    }>;
    expiredCollections: Array<{
      id: string;
      userId: string;
      projectId: string | null;
    }>;
  }>;
}

export interface IQueryBulkRepositoryPort {
  findByIds(
    userId: string,
    ids: string[],
    projectId?: string,
    tx?: Prisma.TransactionClient,
    includeContent?: boolean,
  ): Promise<Array<{ id: string; [key: string]: unknown }>>;
}

export class CommandBulkOperations {
  public static async collectStorageDeletesForItems(
    client: Prisma.TransactionClient | PrismaService,
    itemIds: string[],
    fallbackSpaceByItemId?: ReadonlyMap<string, string>,
  ): Promise<Array<{ fileId: string; spaceId?: string }>> {
    if (itemIds.length === 0) return [];
    const seen = new Map<string, { fileId: string; spaceId?: string }>();
    const addEntry = (fileId: string, spaceId?: string) => {
      if (!fileId) return;
      const key = `${spaceId ?? ''}:${fileId}`;
      if (!seen.has(key)) {
        seen.set(key, spaceId ? { fileId, spaceId } : { fileId });
      }
    };

    const [attachments, metadataRecords] = await Promise.all([
      client.attachment.findMany({
        where: { itemId: { in: itemIds } },
        select: {
          id: true,
          itemId: true,
          fileId: true,
          url: true,
          item: { select: { spaceId: true } },
        },
      }),
      client.itemMetadata
        ? client.itemMetadata.findMany({
            where: { itemId: { in: itemIds } },
            select: {
              itemId: true,
              rawPayload: true,
              item: { select: { spaceId: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    const attachmentIds: string[] = [];
    const attachmentSpaceById = new Map<string, string | undefined>();
    for (const attachment of attachments) {
      const attRec = attachment as {
        id?: string;
        itemId?: string;
        fileId?: string | null;
        url?: string;
        item?: { spaceId?: string } | null;
      };
      const resolvedSpaceId =
        attRec.item?.spaceId ??
        (attRec.itemId ? fallbackSpaceByItemId?.get(attRec.itemId) : undefined);
      if (attRec.id) {
        attachmentIds.push(attRec.id);
        attachmentSpaceById.set(attRec.id, resolvedSpaceId);
      }
      const fileId = attRec.fileId || extractFileIdFromUrl(attRec.url);
      if (fileId) addEntry(fileId, resolvedSpaceId);
    }

    if (attachmentIds.length > 0 && client.attachmentRevision) {
      const revisions = await client.attachmentRevision.findMany({
        where: { attachmentId: { in: attachmentIds } },
        select: { attachmentId: true, fileId: true, url: true },
      });
      for (const rev of revisions) {
        const fileId = rev.fileId || extractFileIdFromUrl(rev.url);
        if (fileId) {
          addEntry(fileId, attachmentSpaceById.get(rev.attachmentId));
        }
      }
    }

    for (const rec of metadataRecords) {
      const metaRec = rec as {
        itemId?: string;
        rawPayload: unknown;
        item?: { spaceId?: string } | null;
      };
      const raw = metaRec.rawPayload as
        | (Record<string, unknown> & { isOffloaded?: boolean; fileId?: string })
        | null;
      if (raw?.isOffloaded && typeof raw.fileId === 'string' && raw.fileId) {
        const resolvedSpaceId =
          metaRec.item?.spaceId ??
          (metaRec.itemId
            ? fallbackSpaceByItemId?.get(metaRec.itemId)
            : undefined);
        addEntry(raw.fileId, resolvedSpaceId);
      }
    }

    return Array.from(seen.values());
  }

  public static async collectStoragePathsForItems(
    client: Prisma.TransactionClient | PrismaService,
    itemIds: string[],
  ): Promise<string[]> {
    const entries = await this.collectStorageDeletesForItems(client, itemIds);
    return Array.from(new Set(entries.map((entry) => entry.fileId)));
  }

  public static async softDeleteMany(
    client: Prisma.TransactionClient | PrismaService,
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ succeededIds: string[]; failedIds: string[] }> {
    const validUserId = isUuid(userId);
    const validIds = Array.from(new Set(itemIds.filter((id) => isUuid(id))));
    if (!validUserId || validIds.length === 0)
      return { succeededIds: [], failedIds: [...itemIds] };

    const validProjectId = normalizeProjectSpaceId(projectId);
    const scopeFilter: Prisma.LibraryItemWhereInput = {
      spaceId: resolveSpaceId({
        userId,
        projectId:
          validProjectId && isUuid(validProjectId) ? validProjectId : undefined,
      }),
    };

    const existingItems = await client.libraryItem.findMany({
      where: { id: { in: validIds }, deletedAt: null, ...scopeFilter },
      select: { id: true },
    });

    const foundSet = new Set(existingItems.map((it) => it.id));
    const succeededIds = itemIds.filter(
      (id, idx) => foundSet.has(id) && itemIds.indexOf(id) === idx,
    );
    const failedIds = itemIds.filter(
      (id, idx) => !foundSet.has(id) || itemIds.indexOf(id) !== idx,
    );

    if (succeededIds.length > 0) {
      const deletedAt = new Date();
      await client.libraryItem.updateMany({
        where: { id: { in: succeededIds }, deletedAt: null, ...scopeFilter },
        data: {
          deletedAt,
          deletedById: userId,
          noteCount: 0,
          attachmentCount: 0,
          hasFile: false,
          version: { increment: 1 },
        },
      });

      await Promise.all([
        client.libraryNote?.updateMany?.({
          where: { itemId: { in: succeededIds }, deletedAt: null },
          data: { deletedAt },
        }),
        client.attachment?.updateMany?.({
          where: { itemId: { in: succeededIds }, deletedAt: null },
          data: { deletedAt },
        }),
        client.annotation?.updateMany?.({
          where: {
            attachment: { itemId: { in: succeededIds } },
            deletedAt: null,
          },
          data: { deletedAt },
        }),
      ]);
    }

    return { succeededIds, failedIds };
  }

  public static async restoreMany(
    client: Prisma.TransactionClient | PrismaService,
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{
    restoredItems: Array<{
      id: string;
      version: number;
      projectId: string | null;
    }>;
    succeededIds: string[];
    failedIds: string[];
  }> {
    const validUserId = isUuid(userId);
    const validIds = Array.from(new Set(itemIds.filter((id) => isUuid(id))));
    if (!validUserId || validIds.length === 0) {
      return { restoredItems: [], succeededIds: [], failedIds: [...itemIds] };
    }

    const validProjectId = normalizeProjectSpaceId(projectId);
    const scopeFilter: Prisma.LibraryItemWhereInput = {
      spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
    };

    const existingItems = await client.libraryItem.findMany({
      where: { id: { in: validIds }, deletedAt: { not: null }, ...scopeFilter },
      select: {
        id: true,
        version: true,
        spaceId: true,
        metadata: true,
        deletedAt: true,
      },
    });

    const restorableMap = new Map<
      string,
      {
        id: string;
        version: number;
        projectId: string | null;
        deletedAt: Date | null;
        cleanedMetadata?: Prisma.InputJsonValue;
      }
    >();
    for (const item of existingItems) {
      const metadataObj =
        item.metadata &&
        typeof item.metadata === 'object' &&
        !Array.isArray(item.metadata)
          ? { ...(item.metadata as Record<string, unknown>) }
          : {};
      let cleanedMetadata: Prisma.InputJsonValue | undefined;
      if (
        typeof metadataObj.mergedIntoId === 'string' &&
        metadataObj.mergedIntoId
      ) {
        delete metadataObj.mergedIntoId;
        delete metadataObj.mergedAt;
        cleanedMetadata = metadataObj as Prisma.InputJsonValue;
      }
      const itemRec = item as Record<string, unknown>;
      const resolvedProjectId =
        typeof itemRec.projectId === 'string'
          ? itemRec.projectId
          : item.spaceId && item.spaceId !== userId
            ? item.spaceId
            : (validProjectId ?? null);
      restorableMap.set(item.id, {
        id: item.id,
        version: item.version + 1,
        projectId: resolvedProjectId,
        deletedAt: item.deletedAt,
        cleanedMetadata,
      });
    }

    const succeededIds = itemIds.filter(
      (id, idx) => restorableMap.has(id) && itemIds.indexOf(id) === idx,
    );
    const failedIds = itemIds.filter(
      (id, idx) => !restorableMap.has(id) || itemIds.indexOf(id) !== idx,
    );

    if (succeededIds.length > 0) {
      await client.libraryItem.updateMany({
        where: {
          id: { in: succeededIds },
          deletedAt: { not: null },
          ...scopeFilter,
        },
        data: {
          deletedAt: null,
          deletedById: null,
          updatedById: userId,
          version: { increment: 1 },
        },
      });

      const mergedRestoredEntries = succeededIds
        .map((id) => restorableMap.get(id))
        .filter(
          (
            entry,
          ): entry is NonNullable<typeof entry> & {
            cleanedMetadata: Prisma.InputJsonValue;
          } => Boolean(entry && entry.cleanedMetadata !== undefined),
        );
      if (
        mergedRestoredEntries.length > 0 &&
        typeof client.libraryItem?.update === 'function'
      ) {
        await Promise.all(
          mergedRestoredEntries.map((entry) =>
            client.libraryItem.update({
              where: { id: entry.id },
              data: { metadata: entry.cleanedMetadata },
            }),
          ),
        );
      }

      const deletedBuckets = new Map<
        string,
        { deletedAt: Date | null; ids: string[] }
      >();
      for (const id of succeededIds) {
        const itemDeletedAt = restorableMap.get(id)?.deletedAt ?? null;
        const bucketKey = itemDeletedAt
          ? String(itemDeletedAt.getTime())
          : 'null';
        const bucket = deletedBuckets.get(bucketKey) ?? {
          deletedAt: itemDeletedAt,
          ids: [],
        };
        bucket.ids.push(id);
        deletedBuckets.set(bucketKey, bucket);
      }

      await Promise.all(
        Array.from(deletedBuckets.values()).flatMap(({ deletedAt, ids }) => {
          const deletedFilter = deletedAt ? { gte: deletedAt } : { not: null };
          const itemFilter = ids.length === 1 ? ids[0] : { in: ids };
          return [
            client.libraryNote?.updateMany?.({
              where: { itemId: itemFilter, deletedAt: deletedFilter },
              data: { deletedAt: null },
            }),
            client.attachment?.updateMany?.({
              where: { itemId: itemFilter, deletedAt: deletedFilter },
              data: { deletedAt: null },
            }),
            client.annotation?.updateMany?.({
              where: {
                attachment: { itemId: itemFilter },
                deletedAt: deletedFilter,
              },
              data: { deletedAt: null },
            }),
          ];
        }),
      );

      const [noteGroups, attachmentGroups] = await Promise.all([
        client.libraryNote.groupBy({
          by: ['itemId'],
          where: { itemId: { in: succeededIds }, deletedAt: null },
          _count: { id: true },
        }),
        client.attachment.groupBy({
          by: ['itemId'],
          where: { itemId: { in: succeededIds }, deletedAt: null },
          _count: { id: true },
        }),
      ]);
      const noteCountMap = new Map<string, number>();
      for (const ng of noteGroups)
        if (ng.itemId) noteCountMap.set(ng.itemId, ng._count.id);

      const attachmentCountMap = new Map<string, number>();
      for (const ag of attachmentGroups)
        if (ag.itemId) attachmentCountMap.set(ag.itemId, ag._count.id);

      const countBuckets = new Map<
        string,
        { nc: number; ac: number; ids: string[] }
      >();
      for (const id of succeededIds) {
        const nc = noteCountMap.get(id) ?? 0;
        const ac = attachmentCountMap.get(id) ?? 0;
        const key = `${nc}:${ac}`;
        const bucket = countBuckets.get(key) ?? { nc, ac, ids: [] };
        bucket.ids.push(id);
        countBuckets.set(key, bucket);
      }

      await Promise.all(
        Array.from(countBuckets.values()).map(({ nc, ac, ids }) =>
          client.libraryItem.updateMany({
            where: { id: { in: ids } },
            data: { noteCount: nc, attachmentCount: ac, hasFile: ac > 0 },
          }),
        ),
      );
    }

    const restoredItems = succeededIds
      .map((id) => restorableMap.get(id)!)
      .filter(Boolean);
    return { restoredItems, succeededIds, failedIds };
  }

  public static async purgeMany(
    client: Prisma.TransactionClient | PrismaService,
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{
    succeededIds: string[];
    failedIds: string[];
    fileIdsToDelete: string[];
    storagePaths: string[];
  }> {
    const validUserId = isUuid(userId);
    const validIds = Array.from(new Set(itemIds.filter((id) => isUuid(id))));
    if (!validUserId || validIds.length === 0) {
      return {
        succeededIds: [],
        failedIds: [...itemIds],
        fileIdsToDelete: [],
        storagePaths: [],
      };
    }

    const validProjectId = normalizeProjectSpaceId(projectId);
    const scopeFilter: Prisma.LibraryItemWhereInput = {
      spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
    };

    const existingItems = await client.libraryItem.findMany({
      where: {
        id: { in: validIds },
        deletedAt: { not: null },
        ...scopeFilter,
      },
      select: { id: true },
    });

    const purgeableSet = new Set(existingItems.map((it) => it.id));
    const succeededIds = itemIds.filter(
      (id, idx) => purgeableSet.has(id) && itemIds.indexOf(id) === idx,
    );
    const failedIds = itemIds.filter(
      (id, idx) => !purgeableSet.has(id) || itemIds.indexOf(id) !== idx,
    );

    let storagePaths: string[] = [];
    if (succeededIds.length > 0) {
      storagePaths = await this.collectStoragePathsForItems(
        client,
        succeededIds,
      );

      await client.libraryItem.deleteMany({
        where: {
          id: { in: succeededIds },
          ...scopeFilter,
        },
      });
    }

    return {
      succeededIds,
      failedIds,
      fileIdsToDelete: storagePaths,
      storagePaths,
    };
  }

  public static async purgeExpiredTrash(
    client: Prisma.TransactionClient | PrismaService,
    retentionDays: number = 30,
    limit: number = 200,
  ): Promise<{
    purgedItems: number;
    purgedNotes: number;
    purgedCollections: number;
    storagePaths: string[];
    storageDeletes: Array<{ fileId: string; spaceId?: string }>;
    expiredItems: Array<{
      id: string;
      userId: string;
      projectId: string | null;
    }>;
    expiredNotes: Array<{
      id: string;
      userId: string;
      projectId: string | null;
    }>;
    expiredCollections: Array<{
      id: string;
      userId: string;
      projectId: string | null;
    }>;
  }> {
    const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);

    const [rawExpiredItems, rawExpiredNotes, rawExpiredCollections] =
      await Promise.all([
        client.libraryItem.findMany({
          where: { deletedAt: { lt: cutoff } },
          select: { id: true, spaceId: true, createdById: true },
          orderBy: { deletedAt: 'asc' },
          take: limit,
        }),
        client.libraryNote.findMany({
          where: { deletedAt: { lt: cutoff } },
          select: { id: true, spaceId: true, createdById: true },
          orderBy: { deletedAt: 'asc' },
          take: limit,
        }),
        client.libraryCollection.findMany({
          where: { deletedAt: { lt: cutoff } },
          select: { id: true, spaceId: true, createdById: true },
          orderBy: { deletedAt: 'asc' },
          take: limit,
        }),
      ]);
    const mapExpiredScope = (row: {
      id: string;
      spaceId?: string;
      createdById?: string;
      userId?: string;
      projectId?: string | null;
    }) => {
      const userId = row.userId || row.createdById || row.spaceId || '';
      const projectId =
        row.projectId !== undefined
          ? row.projectId
          : row.spaceId && row.createdById && row.spaceId !== row.createdById
            ? row.spaceId
            : null;
      return { id: row.id, userId, projectId };
    };
    const expiredItemSpaceMap = new Map<string, string>();
    for (const row of rawExpiredItems) {
      if (row.spaceId) {
        expiredItemSpaceMap.set(row.id, row.spaceId);
      }
    }
    const expiredItems = rawExpiredItems.map(mapExpiredScope);
    const expiredNotes = rawExpiredNotes.map(mapExpiredScope);
    const expiredCollections = rawExpiredCollections.map(mapExpiredScope);
    const expiredItemIds = expiredItems.map((it) => it.id);

    const [itemPurgeRes, delNotes, delCollections] = await Promise.all([
      expiredItemIds.length > 0
        ? (async () => {
            const deletes = await this.collectStorageDeletesForItems(
              client,
              expiredItemIds,
              expiredItemSpaceMap,
            );
            const delItems = await client.libraryItem.deleteMany({
              where: { id: { in: expiredItemIds } },
            });
            return { deletes, count: delItems.count };
          })()
        : Promise.resolve({
            deletes: [] as Array<{ fileId: string; spaceId?: string }>,
            count: 0,
          }),
      expiredNotes.length > 0
        ? client.libraryNote.deleteMany({
            where: { id: { in: expiredNotes.map((n) => n.id) } },
          })
        : Promise.resolve({ count: 0 }),
      expiredCollections.length > 0
        ? client.libraryCollection.deleteMany({
            where: { id: { in: expiredCollections.map((c) => c.id) } },
          })
        : Promise.resolve({ count: 0 }),
    ]);
    const storageDeletes = itemPurgeRes.deletes;
    const storagePaths = Array.from(
      new Set(storageDeletes.map((d) => d.fileId)),
    );
    const purgedItems = itemPurgeRes.count;
    const purgedNotes = delNotes.count;
    const purgedCollections = delCollections.count;

    return {
      purgedItems,
      purgedNotes,
      purgedCollections,
      storagePaths,
      storageDeletes,
      expiredItems,
      expiredNotes,
      expiredCollections,
    };
  }

  public static async emptyTrash(
    client: Prisma.TransactionClient | PrismaService,
    userId: string,
    projectId?: string,
  ): Promise<{
    succeededIds: string[];
    failedIds: string[];
    fileIdsToDelete: string[];
    storagePaths: string[];
  }> {
    if (!isUuid(userId)) {
      return {
        succeededIds: [],
        failedIds: [],
        fileIdsToDelete: [],
        storagePaths: [],
      };
    }
    const validProjectId = normalizeProjectSpaceId(projectId);
    const scopeFilter: Prisma.LibraryItemWhereInput = {
      spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
    };

    const trashedItems = await client.libraryItem.findMany({
      where: {
        deletedAt: { not: null },
        ...scopeFilter,
      },
      select: { id: true, metadata: true },
    });
    const trashedIds = trashedItems
      .filter((it) => {
        const meta =
          it.metadata &&
          typeof it.metadata === 'object' &&
          !Array.isArray(it.metadata)
            ? (it.metadata as Record<string, unknown>)
            : {};
        return !(
          typeof meta.mergedIntoId === 'string' &&
          meta.mergedIntoId.trim().length > 0
        );
      })
      .map((it) => it.id);
    if (trashedIds.length === 0) {
      return {
        succeededIds: [],
        failedIds: [],
        fileIdsToDelete: [],
        storagePaths: [],
      };
    }
    const CHUNK_SIZE = 500;
    const allSucceeded: string[] = [];
    const allFailed: string[] = [];
    const allFileIds: string[] = [];
    const allStoragePaths: string[] = [];

    for (let i = 0; i < trashedIds.length; i += CHUNK_SIZE) {
      const chunk = trashedIds.slice(i, i + CHUNK_SIZE);
      const res = await this.purgeMany(client, userId, chunk, projectId);
      allSucceeded.push(...res.succeededIds);
      allFailed.push(...res.failedIds);
      allFileIds.push(...res.fileIdsToDelete);
      allStoragePaths.push(...res.storagePaths);
    }

    return {
      succeededIds: allSucceeded,
      failedIds: allFailed,
      fileIdsToDelete: allFileIds,
      storagePaths: allStoragePaths,
    };
  }
}

export async function executeBulkSoftDeleteInTx(params: {
  command: ICommandBulkRepositoryPort;
  userId: string;
  itemIds: string[];
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  validProjectId?: string;
}) {
  const { command, userId, itemIds, tx, helpers, validProjectId } = params;
  const res = await command.softDeleteMany(userId, itemIds, tx, validProjectId);
  if (res.succeededIds.length > 0) {
    const eventScope = { userId, projectId: validProjectId };
    const deletedAt = new Date();
    const deletedIso = deletedAt.toISOString();
    await helpers.recordTombstonesBatch(
      eventScope,
      res.succeededIds.map((entityId) => ({ entityType: 'Item', entityId })),
    );
    await helpers.appendChangesBatch(
      eventScope,
      res.succeededIds.map((id) => ({
        entityType: 'Item',
        entityId: id,
        action: 'delete',
        version: 0,
        data: { id, deletedAt: deletedIso },
      })),
    );
    await helpers.publishOutboxBatch(
      eventScope,
      res.succeededIds.map((id) => ({
        aggregateId: id,
        eventType: LIBRARY_EVENT_TYPES.ITEM_DELETED,
        payload: {
          id,
          deletedAt,
          projectId: validProjectId,
          cascadedInTx: true,
        },
      })),
    );
  }
  return res;
}

export async function executeBulkRestoreInTx(params: {
  command: ICommandBulkRepositoryPort;
  query: IQueryBulkRepositoryPort;
  userId: string;
  itemIds: string[];
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  validProjectId?: string;
}) {
  const { command, query, userId, itemIds, tx, helpers, validProjectId } =
    params;
  const res = await command.restoreMany(userId, itemIds, tx, validProjectId);
  if (res.restoredItems.length > 0) {
    const restoredFullItems = await query.findByIds(
      userId,
      res.succeededIds,
      validProjectId,
      tx,
      false,
    );
    const fullItemMap = new Map(
      (restoredFullItems || []).map((it) => [it.id, it]),
    );
    const restoredAt = new Date().toISOString();
    await helpers.appendChangesBatch(
      res.restoredItems.map((restored) => {
        const effectiveProjectId =
          validProjectId || restored.projectId || undefined;
        const fullItem = fullItemMap.get(restored.id);
        const mapped = fullItem
          ? {
              ...ItemsMapper.stripPersonalOverlayForSharedScope(
                ItemsMapper.toDomain(fullItem),
                effectiveProjectId,
              ),
              isRestored: true,
            }
          : {
              id: restored.id,
              version: restored.version,
              projectId: effectiveProjectId,
              isRestored: true,
            };
        return {
          userId,
          projectId: effectiveProjectId,
          entityType: 'Item',
          entityId: restored.id,
          action: 'update' as const,
          version: restored.version,
          data: mapped,
        };
      }),
    );
    await helpers.removeTombstonesBatch(
      { userId, projectId: validProjectId },
      'Item',
      res.restoredItems.map((r) => r.id),
    );
    await helpers.publishOutboxBatch(
      res.restoredItems.map((restored) => {
        const effectiveProjectId =
          validProjectId || restored.projectId || undefined;
        return {
          userId,
          projectId: effectiveProjectId,
          aggregateId: restored.id,
          eventType: LIBRARY_EVENT_TYPES.ITEM_RESTORED,
          payload: {
            itemId: restored.id,
            userId,
            projectId: effectiveProjectId,
            restoredAt,
            cascadedInTx: true,
          },
        };
      }),
    );
  }
  return res;
}

export async function executeBulkPurgeInTx(params: {
  command: ICommandBulkRepositoryPort;
  userId: string;
  itemIds: string[];
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  validProjectId?: string;
}) {
  const { command, userId, itemIds, tx, helpers, validProjectId } = params;
  const res = await command.purgeMany(userId, itemIds, tx, validProjectId);
  await emitPurgeChangeAndOutbox(res, userId, validProjectId, helpers);
  return res;
}

export async function executeEmptyTrashInTx(params: {
  command: ICommandBulkRepositoryPort;
  userId: string;
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  validProjectId?: string;
}) {
  const { command, userId, tx, helpers, validProjectId } = params;
  const res = await command.emptyTrash(userId, tx, validProjectId);
  await emitPurgeChangeAndOutbox(res, userId, validProjectId, helpers);
  return res;
}

async function emitPurgeChangeAndOutbox(
  res: { succeededIds: string[]; storagePaths?: string[] },
  userId: string,
  validProjectId: string | undefined,
  helpers: TransactionHelpers,
) {
  if (res.succeededIds.length === 0) return;
  const eventScope = { userId, projectId: validProjectId };
  const purgedAt = new Date().toISOString();
  await helpers.recordTombstonesBatch(
    eventScope,
    res.succeededIds.map((entityId) => ({ entityType: 'Item', entityId })),
  );
  await helpers.appendChangesBatch(
    eventScope,
    res.succeededIds.map((entityId) => ({
      entityType: 'Item',
      entityId,
      action: 'delete',
      version: 0,
    })),
  );
  await helpers.publishOutboxBatch(
    eventScope,
    res.succeededIds.map((id, idx) => ({
      aggregateId: id,
      eventType: LIBRARY_EVENT_TYPES.ITEM_PURGED,
      payload: {
        itemId: id,
        ...(idx === 0 ? { itemIds: res.succeededIds } : {}),
        userId,
        projectId: validProjectId,
        filePaths: idx === 0 ? res.storagePaths : [],
        purgedAt,
        cascadedInTx: true,
        storageDeletedInTx: false,
      },
    })),
  );
}

const executeBulkHardDeleteInTx = executeBulkPurgeInTx;

export async function executePurgeExpiredTrashInTx(params: {
  command: ICommandBulkRepositoryPort;
  retentionDays: number;
  limit: number;
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
}) {
  const { command, retentionDays, limit, tx, helpers } = params;
  const res = await command.purgeExpiredTrash(retentionDays, limit, tx);
  const expiredItems = res.expiredItems ?? [];
  const toTombstone = (
    rows: Array<{ id: string; userId: string; projectId?: string | null }> = [],
    entityType: string,
  ) =>
    rows.map((r) => ({
      userId: r.userId,
      projectId: r.projectId ?? undefined,
      entityType,
      entityId: r.id,
    }));
  const tombstoneInputs = [
    ...toTombstone(expiredItems, 'Item'),
    ...toTombstone(res.expiredNotes, 'Note'),
    ...toTombstone(res.expiredCollections, 'Collection'),
  ];
  if (tombstoneInputs.length > 0) {
    await helpers.recordTombstonesBatch(tombstoneInputs);
    await helpers.appendChangesBatch(
      tombstoneInputs.map((entry) => ({
        ...entry,
        action: 'delete' as const,
        version: 0,
      })),
    );
  }

  if (expiredItems.length > 0) {
    const purgedAt = new Date().toISOString();
    const allExpiredItemIds = expiredItems.map((it) => it.id);
    await helpers.publishOutboxBatch(
      expiredItems.map((it, idx) => ({
        userId: it.userId,
        projectId: it.projectId ?? undefined,
        aggregateId: it.id,
        eventType: LIBRARY_EVENT_TYPES.ITEM_PURGED,
        payload: {
          itemId: it.id,
          ...(idx === 0 ? { itemIds: allExpiredItemIds } : {}),
          userId: it.userId,
          projectId: it.projectId ?? undefined,
          filePaths: idx === 0 ? res.storagePaths : [],
          purgedAt,
          cascadedInTx: true,
          storageDeletedInTx: false,
        },
      })),
    );
  }
  return res;
}
