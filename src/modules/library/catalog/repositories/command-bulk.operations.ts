import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  extractFileIdFromUrl,
  normalizeProjectScopeId,
} from '@/modules/library/core';
import { isUuid } from '@/modules/library/catalog/domain/command-payload.builder';

export class CommandBulkOperations {
  public static async collectStoragePathsForItems(
    client: Prisma.TransactionClient | PrismaService,
    itemIds: string[],
  ): Promise<string[]> {
    if (itemIds.length === 0) return [];
    const paths = new Set<string>();

    const attachments = await client.attachment.findMany({
      where: { itemId: { in: itemIds } },
      select: { id: true, fileId: true, url: true },
    });
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

    if (client.itemMetadata) {
      const metadataRecords = await client.itemMetadata.findMany({
        where: { itemId: { in: itemIds } },
        select: { rawPayload: true },
      });
      for (const rec of metadataRecords) {
        const raw = rec.rawPayload as
          | (Record<string, unknown> & {
              isOffloaded?: boolean;
              fileId?: string;
            })
          | null;
        if (raw?.isOffloaded && typeof raw.fileId === 'string' && raw.fileId) {
          paths.add(raw.fileId);
        }
      }
    }

    return Array.from(paths);
  }

  public static async softDeleteMany(
    client: Prisma.TransactionClient | PrismaService,
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ succeededIds: string[]; failedIds: string[] }> {
    const validUserId = isUuid(userId);
    const validIds = Array.from(
      new Set(itemIds.filter((id) => isUuid(id))),
    );
    if (!validUserId || validIds.length === 0) {
      return { succeededIds: [], failedIds: [...itemIds] };
    }

    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeFilter: Prisma.ItemWhereInput =
      validProjectId && isUuid(validProjectId)
        ? { projectId: validProjectId }
        : { userId, projectId: null };

    const existingItems = await client.item.findMany({
      where: {
        id: { in: validIds },
        deletedAt: null,
        ...scopeFilter,
      },
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
      await client.item.updateMany({
        where: {
          id: { in: succeededIds },
          deletedAt: null,
          ...scopeFilter,
        },
        data: {
          deletedAt,
          version: { increment: 1 },
        },
      });

      await Promise.all([
        client.note?.updateMany?.({
          where: {
            itemId: { in: succeededIds },
            deletedAt: null,
          },
          data: { deletedAt },
        }),
        client.attachment?.updateMany?.({
          where: {
            itemId: { in: succeededIds },
            deletedAt: null,
          },
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
    restoredItems: Array<{ id: string; version: number; projectId: string | null }>;
    succeededIds: string[];
    failedIds: string[];
  }> {
    const validUserId = isUuid(userId);
    const validIds = Array.from(
      new Set(itemIds.filter((id) => isUuid(id))),
    );
    if (!validUserId || validIds.length === 0) {
      return { restoredItems: [], succeededIds: [], failedIds: [...itemIds] };
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
      select: { id: true, version: true, projectId: true, metadata: true, deletedAt: true },
    });

    const restorableMap = new Map<
      string,
      { id: string; version: number; projectId: string | null; deletedAt: Date | null }
    >();
    for (const item of existingItems) {
      const metadataObj =
        item.metadata &&
        typeof item.metadata === 'object' &&
        !Array.isArray(item.metadata)
          ? (item.metadata as Record<string, unknown>)
          : {};
      if (
        typeof metadataObj.mergedIntoId === 'string' &&
        metadataObj.mergedIntoId
      ) {
        continue;
      }
      restorableMap.set(item.id, {
        id: item.id,
        version: item.version + 1,
        projectId: item.projectId,
        deletedAt: item.deletedAt,
      });
    }

    const succeededIds = itemIds.filter(
      (id, idx) => restorableMap.has(id) && itemIds.indexOf(id) === idx,
    );
    const failedIds = itemIds.filter(
      (id, idx) => !restorableMap.has(id) || itemIds.indexOf(id) !== idx,
    );

    if (succeededIds.length > 0) {
      await client.item.updateMany({
        where: {
          id: { in: succeededIds },
          deletedAt: { not: null },
          ...scopeFilter,
        },
        data: {
          deletedAt: null,
          version: { increment: 1 },
        },
      });

      // Cascade un-delete child notes, attachments, annotations per item cutoff
      await Promise.all(
        succeededIds.flatMap((id) => {
          const itemDeletedAt = restorableMap.get(id)?.deletedAt;
          const cascadeCutoff = itemDeletedAt
            ? new Date(itemDeletedAt.getTime() - 2000)
            : undefined;
          const deletedFilter = cascadeCutoff
            ? { gte: cascadeCutoff }
            : { not: null };
          return [
            client.note?.updateMany?.({
              where: { itemId: id, deletedAt: deletedFilter },
              data: { deletedAt: null },
            }),
            client.attachment?.updateMany?.({
              where: { itemId: id, deletedAt: deletedFilter },
              data: { deletedAt: null },
            }),
            client.annotation?.updateMany?.({
              where: {
                attachment: { itemId: id },
                deletedAt: deletedFilter,
              },
              data: { deletedAt: null },
            }),
          ];
        }),
      );

      const [noteGroups, attachmentGroups] = await Promise.all([
        client.note.groupBy({
          by: ['itemId'],
          where: {
            itemId: { in: succeededIds },
            deletedAt: null,
          },
          _count: { id: true },
        }),
        client.attachment.groupBy({
          by: ['itemId'],
          where: {
            itemId: { in: succeededIds },
            deletedAt: null,
          },
          _count: { id: true },
        }),
      ]);
      const noteCountMap = new Map<string, number>();
      for (const ng of noteGroups) {
        if (ng.itemId) noteCountMap.set(ng.itemId, ng._count.id);
      }

      const attachmentCountMap = new Map<string, number>();
      for (const ag of attachmentGroups) {
        if (ag.itemId) attachmentCountMap.set(ag.itemId, ag._count.id);
      }

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
            data: {
              noteCount: nc,
              attachmentCount: ac,
              hasFile: ac > 0,
            },
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
    const validIds = Array.from(
      new Set(itemIds.filter((id) => isUuid(id))),
    );
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
    expiredItems: Array<{ id: string; userId: string; projectId: string | null }>;
    expiredNotes: Array<{ id: string; userId: string; projectId: string | null }>;
    expiredCollections: Array<{ id: string; userId: string; projectId: string | null }>;
  }> {
    const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);

    const expiredItems = await client.item.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true, userId: true, projectId: true },
      orderBy: { deletedAt: 'asc' },
      take: limit,
    });
    const expiredItemIds = expiredItems.map((it) => it.id);

    let storagePaths: string[] = [];
    let purgedItems = 0;
    if (expiredItemIds.length > 0) {
      storagePaths = await this.collectStoragePathsForItems(
        client,
        expiredItemIds,
      );
      const delItems = await client.item.deleteMany({
        where: { id: { in: expiredItemIds } },
      });
      purgedItems = delItems.count;
    }

    const expiredNotes = await client.note.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true, userId: true, projectId: true },
      orderBy: { deletedAt: 'asc' },
      take: limit,
    });
    let purgedNotes = 0;
    if (expiredNotes.length > 0) {
      const delNotes = await client.note.deleteMany({
        where: { id: { in: expiredNotes.map((n) => n.id) } },
      });
      purgedNotes = delNotes.count;
    }

    const expiredCollections = await client.collection.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true, userId: true, projectId: true },
      orderBy: { deletedAt: 'asc' },
      take: limit,
    });
    let purgedCollections = 0;
    if (expiredCollections.length > 0) {
      const delCollections = await client.collection.deleteMany({
        where: { id: { in: expiredCollections.map((c) => c.id) } },
      });
      purgedCollections = delCollections.count;
    }

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

}
