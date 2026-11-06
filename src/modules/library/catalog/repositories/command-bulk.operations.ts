import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  extractFileIdFromUrl,
  normalizeProjectScopeId,
  LIBRARY_EVENT_TYPES,
  TransactionHelpers,
  ItemsMapper,
} from '@/modules/library/core';
import { isUuid } from '@/modules/library/catalog/domain/item-command.mapper';

export interface ICommandBulkRepositoryPort {
  softDeleteMany(userId: string, itemIds: string[], tx?: Prisma.TransactionClient, projectId?: string): Promise<{ succeededIds: string[]; failedIds: string[] }>;
  restoreMany(userId: string, itemIds: string[], tx?: Prisma.TransactionClient, projectId?: string): Promise<{ restoredItems: Array<{ id: string; version: number; projectId: string | null }>; succeededIds: string[]; failedIds: string[] }>;
  purgeMany(userId: string, itemIds: string[], tx?: Prisma.TransactionClient, projectId?: string): Promise<{ succeededIds: string[]; failedIds: string[]; fileIdsToDelete: string[]; storagePaths: string[] }>;
  emptyTrash(userId: string, tx?: Prisma.TransactionClient, projectId?: string): Promise<{ succeededIds: string[]; failedIds: string[]; fileIdsToDelete: string[]; storagePaths: string[] }>;
  purgeExpiredTrash(retentionDays?: number, limit?: number, tx?: Prisma.TransactionClient): Promise<{ purgedItems: number; purgedNotes: number; purgedCollections: number; storagePaths: string[]; expiredItems: Array<{ id: string; userId: string; projectId: string | null }>; expiredNotes: Array<{ id: string; userId: string; projectId: string | null }>; expiredCollections: Array<{ id: string; userId: string; projectId: string | null }> }>;
}

export interface IQueryBulkRepositoryPort {
  findByIds(userId: string, ids: string[], projectId?: string, tx?: Prisma.TransactionClient, includeContent?: boolean): Promise<Array<{ id: string; [key: string]: unknown }>>;
}

export class CommandBulkOperations {
  public static async collectStoragePathsForItems(
    client: Prisma.TransactionClient | PrismaService,
    itemIds: string[],
  ): Promise<string[]> {
    if (itemIds.length === 0) return [];
    const paths = new Set<string>();

    const [attachments, metadataRecords] = await Promise.all([
      client.attachment.findMany({
        where: { itemId: { in: itemIds } },
        select: { id: true, fileId: true, url: true },
      }),
      client.itemMetadata
        ? client.itemMetadata.findMany({
            where: { itemId: { in: itemIds } },
            select: { rawPayload: true },
          })
        : Promise.resolve([]),
    ]);
    const attachmentIds: string[] = [];
    for (const att of attachments) {
      if (att.id) attachmentIds.push(att.id);
      const fileId = att.fileId || extractFileIdFromUrl(att.url);
      if (fileId) paths.add(fileId);
    }

    if (attachmentIds.length > 0 && client.attachmentRevision) {
      const revisions = await client.attachmentRevision.findMany({
        where: { attachmentId: { in: attachmentIds } },
        select: { fileId: true, url: true },
      });
      for (const rev of revisions) {
        const fileId = rev.fileId || extractFileIdFromUrl(rev.url);
        if (fileId) paths.add(fileId);
      }
    }

    for (const rec of metadataRecords) {
      const raw = rec.rawPayload as (Record<string, unknown> & { isOffloaded?: boolean; fileId?: string }) | null;
      if (raw?.isOffloaded && typeof raw.fileId === 'string' && raw.fileId) paths.add(raw.fileId);
    }

    const candidateFileIds = Array.from(paths);
    if (candidateFileIds.length === 0) return [];

    if (typeof client.attachment.findMany === 'function') {
      const activeRefs = await client.attachment.findMany({
        where: { fileId: { in: candidateFileIds }, itemId: { notIn: itemIds }, deletedAt: null },
        select: { fileId: true },
      });
      const referencedSet = new Set((activeRefs || []).map((r) => r.fileId).filter((f): f is string => Boolean(f)));
      return candidateFileIds.filter((fid) => !referencedSet.has(fid));
    }

    const safePaths: string[] = [];
    for (const fileId of candidateFileIds) {
      const remainingRefs = await client.attachment.count({
        where: { fileId, itemId: { notIn: itemIds }, deletedAt: null },
      });
      if (remainingRefs === 0) safePaths.push(fileId);
    }
    return safePaths;
  }

  public static async softDeleteMany(
    client: Prisma.TransactionClient | PrismaService,
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ succeededIds: string[]; failedIds: string[] }> {
    const validUserId = isUuid(userId);
    const validIds = Array.from(new Set(itemIds.filter((id) => isUuid(id))));
    if (!validUserId || validIds.length === 0) return { succeededIds: [], failedIds: [...itemIds] };

    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeFilter: Prisma.ItemWhereInput =
      validProjectId && isUuid(validProjectId) ? { projectId: validProjectId } : { userId, projectId: null };

    const existingItems = await client.item.findMany({
      where: { id: { in: validIds }, deletedAt: null, ...scopeFilter },
      select: { id: true },
    });

    const foundSet = new Set(existingItems.map((it) => it.id));
    const succeededIds = itemIds.filter((id, idx) => foundSet.has(id) && itemIds.indexOf(id) === idx);
    const failedIds = itemIds.filter((id, idx) => !foundSet.has(id) || itemIds.indexOf(id) !== idx);

    if (succeededIds.length > 0) {
      const deletedAt = new Date();
      await client.item.updateMany({
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
        client.note?.updateMany?.({ where: { itemId: { in: succeededIds }, deletedAt: null }, data: { deletedAt } }),
        client.attachment?.updateMany?.({ where: { itemId: { in: succeededIds }, deletedAt: null }, data: { deletedAt } }),
        client.annotation?.updateMany?.({
          where: { attachment: { itemId: { in: succeededIds } }, deletedAt: null },
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
    restoredItems: Array<{ id: string; version: number; projectId: string | null }>;
    succeededIds: string[];
    failedIds: string[];
  }> {
    const validUserId = isUuid(userId);
    const validIds = Array.from(new Set(itemIds.filter((id) => isUuid(id))));
    if (!validUserId || validIds.length === 0) {
      return { restoredItems: [], succeededIds: [], failedIds: [...itemIds] };
    }

    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeFilter: Prisma.ItemWhereInput = validProjectId ? { projectId: validProjectId } : { userId, projectId: null };

    const existingItems = await client.item.findMany({
      where: { id: { in: validIds }, deletedAt: { not: null }, ...scopeFilter },
      select: { id: true, version: true, projectId: true, metadata: true, deletedAt: true },
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
        item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
          ? { ...(item.metadata as Record<string, unknown>) }
          : {};
      let cleanedMetadata: Prisma.InputJsonValue | undefined;
      if (typeof metadataObj.mergedIntoId === 'string' && metadataObj.mergedIntoId) {
        delete metadataObj.mergedIntoId;
        delete metadataObj.mergedAt;
        cleanedMetadata = metadataObj as Prisma.InputJsonValue;
      }
      restorableMap.set(item.id, {
        id: item.id,
        version: item.version + 1,
        projectId: item.projectId,
        deletedAt: item.deletedAt,
        cleanedMetadata,
      });
    }

    const succeededIds = itemIds.filter((id, idx) => restorableMap.has(id) && itemIds.indexOf(id) === idx);
    const failedIds = itemIds.filter((id, idx) => !restorableMap.has(id) || itemIds.indexOf(id) !== idx);

    if (succeededIds.length > 0) {
      await client.item.updateMany({
        where: { id: { in: succeededIds }, deletedAt: { not: null }, ...scopeFilter },
        data: { deletedAt: null, deletedById: null, updatedById: userId, version: { increment: 1 } },
      });

      const mergedRestoredEntries = succeededIds
        .map((id) => restorableMap.get(id))
        .filter(
          (entry): entry is NonNullable<typeof entry> & { cleanedMetadata: Prisma.InputJsonValue } =>
            Boolean(entry && entry.cleanedMetadata !== undefined),
        );
      if (mergedRestoredEntries.length > 0 && typeof client.item?.update === 'function') {
        await Promise.all(
          mergedRestoredEntries.map((entry) =>
            client.item.update({
              where: { id: entry.id },
              data: { metadata: entry.cleanedMetadata },
            }),
          ),
        );
      }

      await Promise.all(
        succeededIds.flatMap((id) => {
          const itemDeletedAt = restorableMap.get(id)?.deletedAt;
          const deletedFilter = itemDeletedAt ? { gte: itemDeletedAt } : { not: null };
          return [
            client.note?.updateMany?.({ where: { itemId: id, deletedAt: deletedFilter }, data: { deletedAt: null } }),
            client.attachment?.updateMany?.({ where: { itemId: id, deletedAt: deletedFilter }, data: { deletedAt: null } }),
            client.annotation?.updateMany?.({
              where: { attachment: { itemId: id }, deletedAt: deletedFilter },
              data: { deletedAt: null },
            }),
          ];
        }),
      );

      const [noteGroups, attachmentGroups] = await Promise.all([
        client.note.groupBy({
          by: ['itemId'], where: { itemId: { in: succeededIds }, deletedAt: null }, _count: { id: true },
        }),
        client.attachment.groupBy({
          by: ['itemId'], where: { itemId: { in: succeededIds }, deletedAt: null }, _count: { id: true },
        }),
      ]);
      const noteCountMap = new Map<string, number>();
      for (const ng of noteGroups) if (ng.itemId) noteCountMap.set(ng.itemId, ng._count.id);

      const attachmentCountMap = new Map<string, number>();
      for (const ag of attachmentGroups) if (ag.itemId) attachmentCountMap.set(ag.itemId, ag._count.id);

      const countBuckets = new Map<string, { nc: number; ac: number; ids: string[] }>();
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
          client.item.updateMany({
            where: { id: { in: ids } },
            data: { noteCount: nc, attachmentCount: ac, hasFile: ac > 0 },
          }),
        ),
      );
    }

    const restoredItems = succeededIds.map((id) => restorableMap.get(id)!).filter(Boolean);
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

    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeFilter: Prisma.ItemWhereInput = validProjectId
      ? { projectId: validProjectId }
      : { userId, projectId: null };

    const existingItems = await client.item.findMany({
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

      await client.item.deleteMany({
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

    const [expiredItems, expiredNotes, expiredCollections] = await Promise.all([
      client.item.findMany({
        where: { deletedAt: { lt: cutoff } },
        select: { id: true, userId: true, projectId: true },
        orderBy: { deletedAt: 'asc' },
        take: limit,
      }),
      client.note.findMany({
        where: { deletedAt: { lt: cutoff } },
        select: { id: true, userId: true, projectId: true },
        orderBy: { deletedAt: 'asc' },
        take: limit,
      }),
      client.collection.findMany({
        where: { deletedAt: { lt: cutoff } },
        select: { id: true, userId: true, projectId: true },
        orderBy: { deletedAt: 'asc' },
        take: limit,
      }),
    ]);
    const expiredItemIds = expiredItems.map((it) => it.id);

    const [itemPurgeRes, delNotes, delCollections] = await Promise.all([
      expiredItemIds.length > 0
        ? (async () => {
            const paths = await this.collectStoragePathsForItems(
              client,
              expiredItemIds,
            );
            const delItems = await client.item.deleteMany({
              where: { id: { in: expiredItemIds } },
            });
            return { paths, count: delItems.count };
          })()
        : Promise.resolve({ paths: [] as string[], count: 0 }),
      expiredNotes.length > 0
        ? client.note.deleteMany({
            where: { id: { in: expiredNotes.map((n) => n.id) } },
          })
        : Promise.resolve({ count: 0 }),
      expiredCollections.length > 0
        ? client.collection.deleteMany({
            where: { id: { in: expiredCollections.map((c) => c.id) } },
          })
        : Promise.resolve({ count: 0 }),
    ]);
    const storagePaths = itemPurgeRes.paths;
    const purgedItems = itemPurgeRes.count;
    const purgedNotes = delNotes.count;
    const purgedCollections = delCollections.count;

    return {
      purgedItems,
      purgedNotes,
      purgedCollections,
      storagePaths,
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
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeFilter: Prisma.ItemWhereInput = validProjectId
      ? { projectId: validProjectId }
      : { userId, projectId: null };

    const trashedItems = await client.item.findMany({
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
    return this.purgeMany(client, userId, trashedIds, projectId);
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
        payload: { id, deletedAt, projectId: validProjectId, cascadedInTx: true },
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
  const { command, query, userId, itemIds, tx, helpers, validProjectId } = params;
  const res = await command.restoreMany(userId, itemIds, tx, validProjectId);
  if (res.restoredItems.length > 0) {
    const restoredFullItems = await query.findByIds(userId, res.succeededIds, validProjectId, tx, false);
    const fullItemMap = new Map((restoredFullItems || []).map((it) => [it.id, it]));
    const restoredAt = new Date().toISOString();
    await helpers.appendChangesBatch(
      res.restoredItems.map((restored) => {
        const effectiveProjectId = validProjectId || restored.projectId || undefined;
        const fullItem = fullItemMap.get(restored.id);
        return {
          userId,
          projectId: effectiveProjectId,
          entityType: 'Item',
          entityId: restored.id,
          action: 'update' as const,
          version: restored.version,
          data: fullItem
            ? ItemsMapper.toDomain(fullItem)
            : { id: restored.id, version: restored.version, projectId: effectiveProjectId },
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
        const effectiveProjectId = validProjectId || restored.projectId || undefined;
        return {
          userId,
          projectId: effectiveProjectId,
          aggregateId: restored.id,
          eventType: LIBRARY_EVENT_TYPES.ITEM_RESTORED,
          payload: { itemId: restored.id, userId, projectId: effectiveProjectId, restoredAt, cascadedInTx: true },
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
  if (res.succeededIds.length > 0) {
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
          itemIds: res.succeededIds,
          userId,
          projectId: validProjectId,
          filePaths: idx === 0 ? res.storagePaths : [],
          purgedAt,
          cascadedInTx: true,
          storageDeletedInTx: true,
        },
      })),
    );
  }
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
  if (res.succeededIds.length > 0) {
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
          itemIds: res.succeededIds,
          userId,
          projectId: validProjectId,
          filePaths: idx === 0 ? res.storagePaths : [],
          purgedAt,
          cascadedInTx: true,
          storageDeletedInTx: true,
        },
      })),
    );
  }
  return res;
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
          itemIds: allExpiredItemIds,
          userId: it.userId,
          projectId: it.projectId ?? undefined,
          filePaths: idx === 0 ? res.storagePaths : [],
          purgedAt,
          cascadedInTx: true,
          storageDeletedInTx: true,
        },
      })),
    );
  }
  return res;
}
