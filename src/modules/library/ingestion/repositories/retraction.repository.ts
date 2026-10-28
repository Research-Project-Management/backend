import { Injectable, Optional } from '@nestjs/common';
import { Prisma, Item } from '@prisma/client';
import { PrismaService } from '@/core';
import { isUUID } from 'class-validator';
import {
  normalizeProjectScopeId,
  LIBRARY_EVENT_TYPES,
  TransactionHelpers,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { ItemsMapper } from '@/modules/library/catalog';
import {
  RetractionDetails,
  RetractionNature,
  RetractionStats,
} from '@/modules/library/ingestion/types/retraction.types';

const isValidId = (val?: unknown): val is string =>
  typeof val === 'string' && isUUID(val);

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
const RETRACTION_IDENTIFIER_FILTER: Prisma.ItemWhereInput = {
  OR: [
    {
      doi: { not: null },
      NOT: { doi: '' },
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
    (i) => (i.type || '').toLowerCase() === type.toLowerCase() && i.value?.trim(),
  );
  return match?.value?.trim() || null;
}

@Injectable()
export class RetractionRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly libraryTx?: TransactionService,
  ) {}

  private getScopeWhere(userId: string, projectId?: string) {
    const normalizedProjectId = normalizeProjectScopeId(projectId);
    if (normalizedProjectId) {
      return { projectId: normalizedProjectId, deletedAt: null };
    }
    return { userId, projectId: null, deletedAt: null };
  }

  async findItemById(userId: string, itemId: string, projectId?: string) {
    if (!isValidId(itemId) || !isValidId(userId)) return null;
    const scopeWhere = this.getScopeWhere(userId, projectId);
    return this.prisma.item.findFirst({
      where: {
        id: itemId,
        ...scopeWhere,
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
      },
    });
  }

  async findItemsForScan(
    userId: string,
    itemIds?: string[],
    projectId?: string,
  ) {
    const scopeWhere = this.getScopeWhere(userId, projectId);
    const items = await this.prisma.item.findMany({
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
        metadata: true,
        identifiers: { select: { type: true, value: true } },
      },
    });

    return items
      .map((item) => {
        const meta = parseItemMetadata(item.metadata);
        const topItem = item as {
          pmid?: string | null;
          isbn?: string | null;
          identifiers?: Array<{ type?: string; value?: string }>;
        };
        return {
          id: item.id,
          title: item.title,
          doi: item.doi ?? findIdentVal(topItem.identifiers, 'doi'),
          pmid:
            topItem.pmid ??
            meta.pmid ??
            findIdentVal(topItem.identifiers, 'pmid') ??
            null,
          isbn:
            topItem.isbn ??
            meta.isbn ??
            findIdentVal(topItem.identifiers, 'isbn') ??
            null,
          isRetracted: Boolean(meta.isRetracted),
          retractionNature: meta.retractionNature ?? null,
          retractionCheckedAt: meta.retractionCheckedAt
            ? new Date(meta.retractionCheckedAt)
            : null,
        };
      })
      .filter((item) => Boolean(item.doi?.trim() || item.pmid?.trim()));
  }

  async findStaleItemsForSync(
    userId: string,
    staleBefore: Date,
    projectId?: string,
    limit = 100,
  ) {
    const scopeWhere = this.getScopeWhere(userId, projectId);
    const items = await this.prisma.item.findMany({
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
        metadata: true,
        retractionCheckedAt: true,
        identifiers: { select: { type: true, value: true } },
      },
      take: limit,
    });

    return items
      .map((item) => {
        const meta = parseItemMetadata(item.metadata);
        const topItem = item as {
          pmid?: string | null;
          isbn?: string | null;
          identifiers?: Array<{ type?: string; value?: string }>;
        };
        const checkedAt =
          item.retractionCheckedAt ??
          (meta.retractionCheckedAt ? new Date(meta.retractionCheckedAt) : null);
        return {
          id: item.id,
          title: item.title,
          doi: item.doi ?? findIdentVal(topItem.identifiers, 'doi'),
          pmid:
            topItem.pmid ??
            meta.pmid ??
            findIdentVal(topItem.identifiers, 'pmid') ??
            null,
          isbn:
            topItem.isbn ??
            meta.isbn ??
            findIdentVal(topItem.identifiers, 'isbn') ??
            null,
          isRetracted: Boolean(meta.isRetracted),
          retractionNature: meta.retractionNature ?? null,
          retractionCheckedAt: checkedAt,
        };
      })
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
        typeof client.item?.findUnique === 'function'
          ? client.item.findUnique.bind(client.item)
          : this.prisma.item.findUnique.bind(this.prisma.item);
      const existing = await findUniqueFn({
        where: { id: itemId },
        select: { metadata: true, userId: true, projectId: true },
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

      const updated = await client.item.update({
        where: { id: itemId },
        data: {
          metadata: metadataObj as unknown as Prisma.InputJsonValue,
          retractionCheckedAt: checkedAt,
          ...(statusChanged ? { version: { increment: 1 } } : {}),
        },
        include: {
          contributors: { orderBy: { orderIndex: 'asc' } },
          itemTags: { include: { tag: true } },
          collectionItems: { include: { collection: true } },
          attachments: { where: { deletedAt: null } },
          notesList: { where: { deletedAt: null } },
          identifiers: true,
        },
      });
      const effectiveUserId = existing?.userId || updated?.userId;
      const domainUpdated = updated
        ? ItemsMapper.mapFlattenedState(
            updated as unknown as Record<string, unknown>,
            effectiveUserId,
          )
        : updated;

      if (statusChanged && updated && effectiveUserId) {
        const effectiveProjectId = normalizeProjectScopeId(
          existing?.projectId ?? updated.projectId,
        );
        const eventScope = {
          userId: effectiveUserId,
          projectId: effectiveProjectId ?? null,
        };
        if (helpers) {
          await helpers.appendChange(eventScope, {
            entityType: 'Item',
            entityId: itemId,
            action: 'update',
            version: updated.version,
            data: domainUpdated as unknown as Prisma.InputJsonValue,
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
        try {
          const seqRecord = effectiveProjectId
            ? await client.syncSequence?.upsert({
                where: { projectId: effectiveProjectId },
                create: {
                  projectId: effectiveProjectId,
                  currentSequence: BigInt(1),
                },
                update: { currentSequence: { increment: BigInt(1) } },
                select: { currentSequence: true },
              })
            : await client.syncSequence?.upsert({
                where: { userId: effectiveUserId },
                create: {
                  userId: effectiveUserId,
                  currentSequence: BigInt(1),
                },
                update: { currentSequence: { increment: BigInt(1) } },
                select: { currentSequence: true },
              });
          const seq = seqRecord?.currentSequence ?? BigInt(1);
          await client.libraryChange?.create({
            data: {
              seq,
              userId: effectiveUserId,
              projectId: effectiveProjectId ?? null,
              entityType: 'Item',
              entityId: itemId,
              action: 'update',
              version: updated.version,
              data: domainUpdated as unknown as Prisma.InputJsonValue,
            },
          });
          await client.outboxEvent?.create({
            data: {
              userId: effectiveUserId,
              projectId: effectiveProjectId ?? null,
              aggregateId: itemId,
              eventType: LIBRARY_EVENT_TYPES.ITEM_UPDATED,
              payload: {
                ...(domainUpdated as unknown as Record<string, unknown>),
                updatedFields: ['isRetracted', 'retractionCheckedAt'],
                source: 'retraction_watch',
              } as unknown as Prisma.InputJsonValue,
              status: 'PENDING',
              retryCount: 0,
            },
          });
        } catch {
          // Non-critical changelog write in standalone repository context
        }
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
    const items = await this.prisma.item.findMany({
      where: {
        ...scopeWhere,
        metadata: {
          path: ['isRetracted'],
          equals: true,
        },
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
        const rec = item as unknown as { retraction?: { isRetracted?: boolean } };
        return meta.isRetracted === true || rec.retraction?.isRetracted === true;
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
    const retractedBaseWhere: Prisma.ItemWhereInput = {
      ...baseWhere,
      metadata: {
        path: ['isRetracted'],
        equals: true,
      },
    };

    const [totalItems, retractedCount, expressionsOfConcernCount, manualCount] =
      await Promise.all([
        this.prisma.item.count({ where: baseWhere }).catch(() => 0),
        this.prisma.item.count({ where: retractedBaseWhere }).catch(() => 0),
        this.prisma.item
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
        this.prisma.item
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

    return {
      totalItems: typeof totalItems === 'number' ? totalItems : retractedCount,
      checkedItems: totalItems,
      retractedCount,
      expressionsOfConcernCount,
      manualCount,
    };
  }

  async findGlobalStaleItemsForSync(staleBefore: Date, limit = 100) {
    const items = await this.prisma.item.findMany({
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
        userId: true,
        projectId: true,
        title: true,
        doi: true,
        metadata: true,
        retractionCheckedAt: true,
        identifiers: { select: { type: true, value: true } },
      },
      take: limit,
    });

    return items
      .map((item) => {
        const meta = parseItemMetadata(item.metadata);
        const topItem = item as {
          pmid?: string | null;
          isbn?: string | null;
          identifiers?: Array<{ type?: string; value?: string }>;
        };
        const checkedAt =
          item.retractionCheckedAt ??
          (meta.retractionCheckedAt ? new Date(meta.retractionCheckedAt) : null);
        return {
          id: item.id,
          userId: item.userId,
          projectId: item.projectId,
          title: item.title,
          doi: item.doi ?? findIdentVal(topItem.identifiers, 'doi'),
          pmid:
            topItem.pmid ??
            meta.pmid ??
            findIdentVal(topItem.identifiers, 'pmid') ??
            null,
          isbn:
            topItem.isbn ??
            meta.isbn ??
            findIdentVal(topItem.identifiers, 'isbn') ??
            null,
          isRetracted: Boolean(meta.isRetracted),
          retractionNature: meta.retractionNature ?? null,
          retractionCheckedAt: checkedAt,
        };
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
