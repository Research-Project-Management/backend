import { Injectable, Optional, Inject } from '@nestjs/common';
import { Prisma, LibraryItem } from '@prisma/client';
import { PrismaService, isUuid as isValidId } from '@/core';

type Item = LibraryItem;
import {
  normalizeProjectScopeId,
  LIBRARY_EVENT_TYPES,
  TransactionHelpers,
  UNIT_OF_WORK,
  IUnitOfWork,
  ItemsMapper,
} from '@/modules/library/core';
import {
  RetractionDetails,
  RetractionNature,
  RetractionStats,
} from '@/modules/library/ingestion/types/ingestion.types';

interface ItemRetractionMetadata {
  pmid?: string | null;
  isbn?: string | null;
  isRetracted?: boolean;
  retractionNature?: RetractionNature | null;
  retractionDetails?: RetractionDetails | null;
  retractionCheckedAt?: string | null;
  [key: string]: unknown;
}

function parseItemMetadata(metadata: unknown): ItemRetractionMetadata {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as ItemRetractionMetadata;
  }
  return {};
}

/**
 * Filter matching Zotero's retraction checking constraint:
 * Only papers with a non-empty DOI or PMID are eligible for retraction audits.
 */
const RETRACTION_IDENTIFIER_FILTER: Prisma.LibraryItemWhereInput = {
  OR: [
    {
      doi: { not: null },
      NOT: { doi: '' },
    },
    {
      pmid: { not: null },
    },
    {
      metadata: {
        path: ['pmid'],
        not: Prisma.AnyNull,
      },
    },
    {
      identifiers: {
        some: {
          type: { in: ['doi', 'pmid', 'arxiv'] },
        },
      },
    },
  ],
};

function findIdentVal(
  identifiers: Array<{ type?: string; value?: string }> | undefined,
  type: string,
): string | null {
  if (!Array.isArray(identifiers)) return null;
  const match = identifiers.find(
    (i) =>
      (i.type || '').toLowerCase() === type.toLowerCase() && i.value?.trim(),
  );
  return match?.value?.trim() || null;
}

@Injectable()
export class RetractionRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx?: IUnitOfWork,
  ) {}

  private getScopeWhere(userId: string, projectId?: string) {
    const normalizedProjectId = normalizeProjectScopeId(projectId);
    if (normalizedProjectId) {
      return { spaceId: normalizedProjectId, deletedAt: null };
    }
    return { spaceId: userId, deletedAt: null };
  }

  async findItemById(userId: string, itemId: string, projectId?: string) {
    if (!isValidId(itemId) || !isValidId(userId)) return null;
    const scopeWhere = this.getScopeWhere(userId, projectId);
    return this.prisma.libraryItem.findFirst({
      where: {
        id: itemId,
        ...scopeWhere,
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
      },
    });
  }

  private mapRetractionRow<
    T extends {
      id: string;
      title: string;
      doi: string | null;
      metadata: unknown;
      retractionCheckedAt?: Date | null;
      spaceId?: string;
      createdById?: string;
      userId?: string;
      projectId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      isRetracted?: boolean;
      identifiers?: Array<{ type?: string; value?: string }>;
    },
  >(item: T) {
    const meta = parseItemMetadata(item.metadata);
    const checkedAt =
      item.retractionCheckedAt ??
      (meta.retractionCheckedAt ? new Date(meta.retractionCheckedAt) : null);
    const resolvedUserId = item.userId ?? item.createdById;
    const resolvedProjectId =
      item.projectId !== undefined
        ? item.projectId
        : item.spaceId && item.createdById && item.spaceId !== item.createdById
          ? item.spaceId
          : null;
    return {
      id: item.id,
      ...(resolvedUserId !== undefined ? { userId: resolvedUserId } : {}),
      ...(resolvedProjectId !== undefined ? { projectId: resolvedProjectId } : {}),
      title: item.title,
      doi: item.doi ?? findIdentVal(item.identifiers, 'doi'),
      pmid:
        item.pmid ??
        meta.pmid ??
        findIdentVal(item.identifiers, 'pmid') ??
        null,
      isbn:
        item.isbn ??
        meta.isbn ??
        findIdentVal(item.identifiers, 'isbn') ??
        null,
      isRetracted: Boolean(item.isRetracted || meta.isRetracted),
      retractionNature: meta.retractionNature ?? null,
      retractionCheckedAt: checkedAt,
    };
  }

  async findItemsForScan(
    userId: string,
    itemIds?: string[],
    projectId?: string,
  ) {
    const scopeWhere = this.getScopeWhere(userId, projectId);
    const items = await this.prisma.libraryItem.findMany({
      where: {
        ...scopeWhere,
        ...(itemIds && itemIds.length > 0
          ? { id: { in: itemIds } }
          : RETRACTION_IDENTIFIER_FILTER),
      },
      take: 500,
      select: {
        id: true,
        title: true,
        doi: true,
        pmid: true,
        isbn: true,
        isRetracted: true,
        metadata: true,
        identifiers: { select: { type: true, value: true } },
      },
    });

    return items
      .map((item) => this.mapRetractionRow(item))
      .filter((item) => Boolean(item.doi?.trim() || item.pmid?.trim()));
  }

  async findStaleItemsForSync(
    userId: string,
    staleBefore: Date,
    projectId?: string,
    limit = 100,
  ) {
    const scopeWhere = this.getScopeWhere(userId, projectId);
    const items = await this.prisma.libraryItem.findMany({
      where: {
        ...scopeWhere,
        ...RETRACTION_IDENTIFIER_FILTER,
        OR: [
          { retractionCheckedAt: null },
          { retractionCheckedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { retractionCheckedAt: { sort: 'asc', nulls: 'first' } },
      select: {
        id: true,
        title: true,
        doi: true,
        pmid: true,
        isbn: true,
        isRetracted: true,
        metadata: true,
        retractionCheckedAt: true,
        identifiers: { select: { type: true, value: true } },
      },
      take: limit,
    });

    return items
      .map((item) => this.mapRetractionRow(item))
      .filter((item) => Boolean(item.doi?.trim() || item.pmid?.trim()))
      .slice(0, limit);
  }

  async updateItemRetraction(
    itemId: string,
    isRetracted: boolean,
    nature?: RetractionNature | null,
    details?: RetractionDetails | null,
    checkedAt: Date = new Date(),
  ): Promise<Item | null> {
    if (!isValidId(itemId)) return null;

    const runUpdate = async (
      client: Prisma.TransactionClient | PrismaService,
      helpers?: TransactionHelpers,
    ) => {
      const findUniqueFn =
        typeof client.libraryItem?.findUnique === 'function'
          ? client.libraryItem.findUnique.bind(client.libraryItem)
          : this.prisma.libraryItem.findUnique.bind(this.prisma.libraryItem);
      const existing = await findUniqueFn({
        where: { id: itemId },
        select: { metadata: true, spaceId: true, createdById: true },
      });
      const prevMeta = parseItemMetadata(existing?.metadata);
      const statusChanged =
        Boolean(prevMeta.isRetracted) !== Boolean(isRetracted) ||
        (prevMeta.retractionNature ?? null) !== (nature || null);
      const metadataObj: ItemRetractionMetadata = {
        ...prevMeta,
        isRetracted,
        retractionNature: nature || null,
        retractionDetails: details || null,
        retractionCheckedAt: checkedAt.toISOString(),
      };

      const updated = await client.libraryItem.update({
        where: { id: itemId },
        data: {
          isRetracted: Boolean(isRetracted),
          metadata: metadataObj as unknown as Prisma.InputJsonValue,
          retractionCheckedAt: checkedAt,
          ...(statusChanged ? { version: { increment: 1 } } : {}),
        },
        ...(statusChanged
          ? {
              include: {
                contributors: { orderBy: { orderIndex: 'asc' } },
                itemTags: { include: { tag: true } },
                collectionItems: { include: { collection: true } },
                attachments: { where: { deletedAt: null } },
                notesList: { where: { deletedAt: null } },
                identifiers: true,
              },
            }
          : {}),
      });
      const existingRec = existing as { userId?: string; createdById?: string; projectId?: string | null; spaceId?: string } | null | undefined;
      const updatedRec = updated as { userId?: string; createdById?: string; projectId?: string | null; spaceId?: string } | null | undefined;
      const effectiveUserId = existingRec?.userId ?? existingRec?.createdById ?? updatedRec?.userId ?? updatedRec?.createdById;
      const rawProjectId =
        existingRec?.projectId ??
        updatedRec?.projectId ??
        (existingRec?.spaceId && existingRec.spaceId !== existingRec.createdById
          ? existingRec.spaceId
          : updatedRec?.spaceId && updatedRec.spaceId !== updatedRec.createdById
            ? updatedRec.spaceId
            : undefined);
      const effectiveProjectId = normalizeProjectScopeId(rawProjectId);
      const rawDomainUpdated =
        statusChanged && updated
          ? ItemsMapper.mapFlattenedState(updated, effectiveUserId)
          : updated;
      const domainUpdated =
        effectiveProjectId &&
        rawDomainUpdated &&
        typeof rawDomainUpdated === 'object'
          ? (() => {
              const clone = {
                ...(rawDomainUpdated as unknown as Record<string, unknown>),
              };
              delete clone.isStarred;
              delete clone.starred;
              delete clone.isRead;
              delete clone.readStatus;
              delete clone.rating;
              delete clone.currentPage;
              delete clone.lastReadPage;
              delete clone.scrollPosition;
              delete clone.lastOpenedAt;
              delete clone.lastReadAt;
              delete clone.isMyPublication;
              delete clone.states;
              delete clone.publications;
              return clone as unknown as typeof rawDomainUpdated;
            })()
          : rawDomainUpdated;

      if (statusChanged && updated && effectiveUserId && helpers) {
        const eventScope = {
          userId: effectiveUserId,
          projectId: effectiveProjectId ?? null,
        };
        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: itemId,
          action: 'update',
          version: updated.version,
          data: domainUpdated,
        });
        await helpers.publishOutbox(
          eventScope,
          itemId,
          LIBRARY_EVENT_TYPES.ITEM_UPDATED,
          {
            ...(domainUpdated as unknown as Record<string, unknown>),
            updatedFields: ['isRetracted', 'retractionCheckedAt'],
            source: 'retraction_watch',
          },
        );
        return domainUpdated as unknown as Item;
      }

      return (domainUpdated ?? updated) as unknown as Item;
    };

    if (this.libraryTx) {
      return this.libraryTx.executeInTransaction((tx, helpers) =>
        runUpdate(tx, helpers),
      );
    }
    if (typeof this.prisma.$transaction === 'function') {
      return this.prisma.$transaction((tx) => runUpdate(tx));
    }
    return runUpdate(this.prisma);
  }

  async findRetractedItems(userId: string, projectId?: string) {
    const scopeWhere = this.getScopeWhere(userId, projectId);
    const items = await this.prisma.libraryItem.findMany({
      where: {
        ...scopeWhere,
        isRetracted: true,
      },
      take: 500,
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: { where: { deletedAt: null }, take: 2 },
        itemTags: { include: { tag: true } },
      },
    });
    return items
      .filter((item) => {
        const meta = parseItemMetadata(item.metadata);
        const rec = item as unknown as {
          isRetracted?: boolean;
          retraction?: { isRetracted?: boolean };
        };
        return (
          rec.isRetracted === true ||
          meta.isRetracted === true ||
          rec.retraction?.isRetracted === true
        );
      })
      .map(
        (item) =>
          ItemsMapper.mapFlattenedState(
            item as unknown as Record<string, unknown>,
            userId,
          ) ?? item,
      );
  }

  async getStats(userId: string, projectId?: string): Promise<RetractionStats> {
    const baseWhere = this.getScopeWhere(userId, projectId);
    const retractedBaseWhere: Prisma.LibraryItemWhereInput = {
      ...baseWhere,
      isRetracted: true,
    };

    const [
      totalItems,
      checkedItemsCount,
      retractedCount,
      expressionsOfConcernCount,
      manualCount,
    ] = await Promise.all([
      this.prisma.libraryItem.count({ where: baseWhere }).catch(() => 0),
      this.prisma.libraryItem
        .count({
          where: {
            ...baseWhere,
            retractionCheckedAt: { not: null },
          },
        })
        .catch(() => null),
      this.prisma.libraryItem.count({ where: retractedBaseWhere }).catch(() => 0),
      this.prisma.libraryItem
        .count({
          where: {
            AND: [
              retractedBaseWhere,
              {
                metadata: {
                  path: ['retractionNature'],
                  equals: 'expression_of_concern',
                },
              },
            ],
          },
        })
        .catch(() => 0),
      this.prisma.libraryItem
        .count({
          where: {
            AND: [
              retractedBaseWhere,
              {
                metadata: {
                  path: ['retractionNature'],
                  equals: 'manual',
                },
              },
            ],
          },
        })
        .catch(() => 0),
    ]);

    const resolvedTotal =
      typeof totalItems === 'number' ? totalItems : retractedCount;
    const resolvedChecked =
      typeof checkedItemsCount === 'number'
        ? Math.max(checkedItemsCount, retractedCount)
        : resolvedTotal;

    return {
      totalItems: resolvedTotal,
      checkedItems: resolvedChecked,
      retractedCount,
      expressionsOfConcernCount,
      manualCount,
    };
  }

  async findGlobalStaleItemsForSync(staleBefore: Date, limit = 100) {
    const items = await this.prisma.libraryItem.findMany({
      where: {
        deletedAt: null,
        ...RETRACTION_IDENTIFIER_FILTER,
        OR: [
          { retractionCheckedAt: null },
          { retractionCheckedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { retractionCheckedAt: { sort: 'asc', nulls: 'first' } },
      select: {
        id: true,
        spaceId: true,
        createdById: true,
        title: true,
        doi: true,
        pmid: true,
        isbn: true,
        isRetracted: true,
        metadata: true,
        retractionCheckedAt: true,
        identifiers: { select: { type: true, value: true } },
      },
      take: limit,
    });

    return items
      .map((item) => {
        const mapped = this.mapRetractionRow(item);
        const itemRec = item as { userId?: string; createdById?: string; projectId?: string | null; spaceId?: string };
        const userId = itemRec.userId ?? itemRec.createdById ?? '';
        const projectId = itemRec.projectId !== undefined ? itemRec.projectId : itemRec.spaceId && itemRec.spaceId !== userId ? itemRec.spaceId : null;
        return Object.assign(mapped, { userId, projectId });
      })
      .filter((item) => Boolean(item.doi?.trim() || item.pmid?.trim()))
      .filter(
        (i) => !i.retractionCheckedAt || i.retractionCheckedAt < staleBefore,
      )
      .slice(0, limit);
  }

  // Retraction Database Seed / Cache Operations
  async countRetractionRecords(): Promise<number> {
    return this.prisma.retraction.count();
  }

  async upsertRetractionRecord(args: Prisma.RetractionUpsertArgs) {
    return this.prisma.retraction.upsert(args);
  }

  async findRetractionRecordsForMemoryIndex(limit = 5000) {
    return this.prisma.retraction.findMany({
      where: { isRetracted: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        doi: true,
        pmid: true,
        title: true,
        nature: true,
        noticeType: true,
        reason: true,
        noticeUrl: true,
        journal: true,
        retractionDate: true,
        source: true,
      },
    });
  }

  async findRetractionRecordByDoi(doi: string) {
    return this.prisma.retraction.findFirst({
      where: { doi },
    });
  }

  async findRetractionRecordByPmid(pmid: string) {
    return this.prisma.retraction.findFirst({
      where: { pmid },
    });
  }

  async findRetractionRecord(where: Prisma.RetractionWhereInput) {
    return this.prisma.retraction.findFirst({
      where,
    });
  }

  async bulkCreateRetractions(
    records: Prisma.RetractionCreateManyInput[],
  ): Promise<number> {
    if (!records.length) return 0;
    const res = await this.prisma.retraction.createMany({
      data: records,
      skipDuplicates: true,
    });
    return res.count;
  }

  /**
   * Fetches only indexed DOI and PMID columns across records (bounded) to populate the In-Memory Bloom Filter.
   */
  async findAllRetractionIdentifiersForBloom(
    limit = 250000,
  ): Promise<Array<{ doi: string; pmid: string | null }>> {
    return this.prisma.retraction.findMany({
      where: { isRetracted: true },
      select: {
        doi: true,
        pmid: true,
      },
      take: limit,
    });
  }

  /**
   * Delta Set Inverted Lookup: Finds all user library items matching a set of DOIs.
   */
  async findItemsByDois(dois: string[]): Promise<
    Array<{
      id: string;
      userId: string;
      projectId: string | null;
      doi: string | null;
      isRetracted: boolean;
      retractionNature: string | null;
    }>
  > {
    if (!dois.length) return [];
    const normalized = Array.from(
      new Set(dois.map((d) => d.toLowerCase().trim())),
    );
    const items = await this.prisma.libraryItem.findMany({
      where: {
        OR: [
          { doi: { in: normalized } },
          { identifiers: { some: { type: 'doi', value: { in: normalized } } } },
        ],
        deletedAt: null,
      },
      select: {
        id: true,
        spaceId: true,
        createdById: true,
        doi: true,
        isRetracted: true,
        metadata: true,
        identifiers: { select: { type: true, value: true } },
      },
    });
    return items.map((it) => {
      const meta = parseItemMetadata(it.metadata);
      const itRec = it as { userId?: string; createdById?: string; projectId?: string | null; spaceId?: string; isRetracted?: boolean };
      const userId = itRec.userId ?? itRec.createdById ?? '';
      const projectId = itRec.projectId !== undefined ? itRec.projectId : itRec.spaceId && itRec.spaceId !== userId ? itRec.spaceId : null;
      return {
        id: it.id,
        userId,
        projectId,
        doi: it.doi ?? findIdentVal(it.identifiers, 'doi'),
        isRetracted: Boolean(itRec.isRetracted || meta.isRetracted),
        retractionNature: meta.retractionNature ?? null,
      };
    });
  }

  async getDatabaseStats(): Promise<{
    totalRecords: number;
    retractedCount: number;
    cleanCount: number;
    sourceBreakdown: Record<string, number>;
    lastCheckedAt?: Date;
  }> {
    const [totalRecords, retractedCount, cleanCount, sources, latest] =
      await Promise.all([
        this.prisma.retraction.count(),
        this.prisma.retraction.count({ where: { isRetracted: true } }),
        this.prisma.retraction.count({ where: { isRetracted: false } }),
        this.prisma.retraction.groupBy({
          by: ['source'],
          _count: true,
        }),
        this.prisma.retraction.findFirst({
          orderBy: { checkedAt: 'desc' },
          select: { checkedAt: true },
        }),
      ]);

    const sourceBreakdown: Record<string, number> = {};
    for (const s of sources) {
      sourceBreakdown[s.source] = s._count;
    }

    return {
      totalRecords,
      retractedCount,
      cleanCount,
      sourceBreakdown,
      lastCheckedAt: latest?.checkedAt ?? undefined,
    };
  }
}
