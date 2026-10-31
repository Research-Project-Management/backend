import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { normalizeProjectScopeId } from '@/modules/library/core';
import {
  ItemDetail,
  ItemSummary,
} from '@/modules/library/core/types/bibliographic.types';
import { TreeEngine } from '@/modules/library/catalog/domain/tree.engine';
import {
  ItemFilterOptions,
  buildItemWhereClause,
} from './item-filter-where.builder';

export type PrismaClientOrTx = Prisma.TransactionClient | PrismaService;

@Injectable()
export class ItemListQueryRepository {
  constructor(
    @Optional()
    private readonly prisma?: PrismaService,
    @Optional()
    private readonly treeEngine: TreeEngine = new TreeEngine(),
  ) {}

  /**
   * Resolves target collection IDs taking into account subcollection inheritance.
   */
  async resolveTargetCollectionIds(
    userId: string,
    options: {
      collectionId?: string;
      collectionIds?: string[];
      includeSubcollections?: boolean;
      recursive?: boolean;
      projectId?: string;
    },
    client: PrismaClientOrTx,
  ): Promise<string[] | undefined> {
    if (options.collectionIds && options.collectionIds.length > 0) {
      return options.collectionIds;
    }

    if (!options.collectionId) {
      return undefined;
    }

    const isRecursive =
      options.includeSubcollections !== false && options.recursive !== false;

    if (!isRecursive) {
      return [options.collectionId];
    }

    const validProjectId = normalizeProjectScopeId(options.projectId);
    const hasValidProject = Boolean(validProjectId && isUuid(validProjectId));

    const scopeWhere: Prisma.CollectionWhereInput = hasValidProject
      ? { projectId: validProjectId, deletedAt: null }
      : { userId, projectId: null, deletedAt: null };

    const allCollections = await client.collection.findMany({
      where: scopeWhere,
      select: { id: true, parentId: true },
    });

    const descendantIds = this.treeEngine.getDescendantIds(
      allCollections,
      options.collectionId,
    );

    return [options.collectionId, ...descendantIds];
  }

  buildWhereClause(
    userId: string,
    options: ItemFilterOptions,
  ): Prisma.ItemWhereInput {
    return buildItemWhereClause(userId, options);
  }

  async findMany(
    client: PrismaClientOrTx,
    userId: string,
    options: {
      view?:
        | 'all'
        | 'recent'
        | 'unfiled'
        | 'trash'
        | 'my-publications'
        | 'publications'
        | 'starred'
        | 'retracted';
      userId?: string;
      collectionId?: string;
      collectionIds?: string[];
      targetCollectionIds?: string[];
      includeSubcollections?: boolean;
      recursive?: boolean;
      tagId?: string;
      tag?: string;
      search?: string;
      hasFile?: boolean;
      hasNotes?: boolean;
      limit?: number;
      page?: number;
      cursor?: string;
      projectId?: string;
      orderBy?: string;
      orderDirection?: 'asc' | 'desc';
      itemType?: string;
      type?: string;
      fromYear?: number;
      toYear?: number;
      readStatus?: string;
      includeNotes?: boolean;
      fields?: string;
    },
  ): Promise<ItemDetail[]> {
    if (!isUuid(userId)) return [];
    const view = options.view ?? 'all';
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);

    const effectiveUserId = options.userId || userId;
    const requestedFields = options.fields
      ? new Set(
          options.fields
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean),
        )
      : null;
    const shouldIncludeNotes =
      options.includeNotes === true ||
      Boolean(
        requestedFields &&
        (requestedFields.has('notes') || requestedFields.has('notesList')),
      );

    const relationPeerSelect = {
      id: true,
      title: true,
      itemType: true,
      year: true,
    };
    const itemInclude = {
      contributors: {
        orderBy: { orderIndex: 'asc' as const },
      },
      itemTags: {
        include: { tag: true },
      },
      collectionItems: {
        include: { collection: true },
      },
      attachments: {
        where: { deletedAt: null },
      },
      identifiers: true,
      publications: {
        where: { userId: effectiveUserId },
      },
      outgoingRel: {
        include: { targetItem: { select: relationPeerSelect } },
      },
      incomingRel: {
        include: { sourceItem: { select: relationPeerSelect } },
      },
      ...(shouldIncludeNotes
        ? {
            notesList: {
              where: { deletedAt: null },
            },
          }
        : {}),
      states: {
        where: { userId: effectiveUserId },
        take: 1,
      },
    };

    const targetCollectionIds =
      options.targetCollectionIds ??
      (await this.resolveTargetCollectionIds(userId, options, client));

    if (view === 'recent' && effectiveUserId) {
      const recentItemWhere = this.buildWhereClause(userId, {
        ...options,
        targetCollectionIds,
        view: 'all',
      });

      const userStates = await client.state.findMany({
        where: {
          userId: effectiveUserId,
          lastReadAt: { not: null },
          item: recentItemWhere,
        },
        orderBy: { lastReadAt: 'desc' },
        take: limit + 1,
        include: {
          item: {
            include: itemInclude,
          },
        },
        ...(options.cursor
          ? {
              cursor: {
                userId_itemId: {
                  userId: effectiveUserId,
                  itemId: options.cursor,
                },
              },
              skip: 1,
            }
          : options.page && options.page > 1
            ? { skip: (options.page - 1) * limit }
            : {}),
      });

      return userStates
        .filter((us): us is typeof us & { item: NonNullable<typeof us.item> } =>
          Boolean(us.item),
        )
        .map((us) => ({
          ...us.item,
          lastReadAt: us.lastReadAt,
        }));
    }

    let sortField = options.orderBy || 'createdAt';
    if (sortField === 'authors') {
      sortField = 'firstAuthor';
    } else if (sortField === 'publication') {
      sortField = 'publicationTitle';
    } else if (sortField === 'dateDeleted') {
      sortField = 'deletedAt';
    }
    const sortDir = options.orderDirection === 'asc' ? 'asc' : 'desc';
    const allowedSortFields = [
      'title',
      'year',
      'createdAt',
      'updatedAt',
      'citationKey',
      'publicationTitle',
      'firstAuthor',
      'deletedAt',
    ];
    const safeSortField = allowedSortFields.includes(sortField)
      ? sortField
      : 'createdAt';
    const orderByClause: Prisma.ItemOrderByWithRelationInput[] = [
      { [safeSortField]: sortDir },
      { id: sortDir },
    ];

    const page = options.page && options.page > 0 ? options.page : 1;
    const skip = options.cursor ? 1 : page > 1 ? (page - 1) * limit : undefined;

    return client.item.findMany({
      where: this.buildWhereClause(userId, { ...options, targetCollectionIds }),
      take: limit + 1,
      ...(options.cursor
        ? { cursor: { id: options.cursor }, skip: 1 }
        : page > 1
          ? { skip }
          : {}),
      orderBy: orderByClause,
      include: itemInclude,
    });
  }

  async count(
    client: PrismaClientOrTx,
    userId: string,
    options: ItemFilterOptions & {
      includeSubcollections?: boolean;
      recursive?: boolean;
    },
  ): Promise<number> {
    if (!isUuid(userId)) return 0;
    const view = options.view ?? 'all';

    const targetCollectionIds =
      options.targetCollectionIds ??
      (await this.resolveTargetCollectionIds(userId, options, client));

    const effectiveUserId = options.userId || userId;
    if (view === 'recent' && effectiveUserId) {
      const recentItemWhere = this.buildWhereClause(userId, {
        ...options,
        targetCollectionIds,
        view: 'all',
      });

      return client.state.count({
        where: {
          userId: effectiveUserId,
          lastReadAt: { not: null },
          item: recentItemWhere,
        },
      });
    }

    return client.item.count({
      where: this.buildWhereClause(userId, { ...options, targetCollectionIds }),
    });
  }

  async countByItemType(
    client: PrismaClientOrTx,
    userId: string,
    projectId?: string,
  ): Promise<Record<string, number>> {
    if (!isUuid(userId)) return {};

    const validProjectId = normalizeProjectScopeId(projectId);
    const where: Prisma.ItemWhereInput =
      validProjectId && isUuid(validProjectId)
        ? { projectId: validProjectId, deletedAt: null }
        : { userId, projectId: null, deletedAt: null };

    try {
      const grouped = await client.item.groupBy({
        by: ['itemType'],
        where,
        _count: { _all: true },
      });

      if (!Array.isArray(grouped)) return {};

      const counts: Record<string, number> = {};
      for (const row of grouped) {
        const key =
          typeof row.itemType === 'string' && row.itemType.trim()
            ? row.itemType.trim()
            : 'journalArticle';
        const countVal =
          typeof row._count === 'object' && row._count !== null
            ? Number(
                (row._count as { _all?: number; itemType?: number })._all ??
                  (row._count as { itemType?: number }).itemType ??
                  0,
              )
            : typeof row._count === 'number'
              ? row._count
              : 0;
        if (countVal > 0) {
          counts[key] = (counts[key] || 0) + countVal;
        }
      }
      return counts;
    } catch {
      return {};
    }
  }

  async findSummaryById(
    client: PrismaClientOrTx,
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemSummary | null> {
    if (!isUuid(itemId)) return null;
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere =
      validProjectId && isUuid(validProjectId)
        ? { projectId: validProjectId }
        : isUuid(userId)
          ? { userId, projectId: null }
          : null;
    if (!scopeWhere) return null;
    const item = await client.item.findFirst({
      where: { id: itemId, ...scopeWhere, deletedAt: null },
      select: {
        id: true,
        userId: true,
        title: true,
        itemType: true,
        year: true,
        doi: true,
        contributors: {
          where: { creatorType: 'author' },
          select: { fullName: true, firstName: true, lastName: true },
          orderBy: { orderIndex: 'asc' },
          take: 3,
        },
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!item) return null;
    return {
      id: item.id,
      userId: item.userId,
      title: item.title,
      itemType: item.itemType || undefined,
      year: item.year,
      doi: item.doi || null,
      primaryAuthors: item.contributors.map(
        (c: {
          fullName: string | null;
          firstName: string | null;
          lastName: string | null;
        }) => c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      ),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  async findSummariesByIds(
    client: PrismaClientOrTx,
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<ItemSummary[]> {
    if (!itemIds || itemIds.length === 0 || !isUuid(userId)) return [];
    const validIds = itemIds.filter(isUuid);
    if (validIds.length === 0) return [];

    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.ItemWhereInput =
      validProjectId && isUuid(validProjectId)
        ? { projectId: validProjectId }
        : { userId, projectId: null };

    const items = await client.item.findMany({
      where: { id: { in: validIds }, ...scopeWhere, deletedAt: null },
      select: {
        id: true,
        userId: true,
        title: true,
        itemType: true,
        year: true,
        doi: true,
        contributors: {
          where: { creatorType: 'author' },
          select: { fullName: true, firstName: true, lastName: true },
          orderBy: { orderIndex: 'asc' },
          take: 3,
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    return items.map((item) => ({
      id: item.id,
      userId: item.userId,
      title: item.title,
      itemType: item.itemType || undefined,
      year: item.year,
      doi: item.doi || null,
      primaryAuthors: item.contributors.map(
        (c) => c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      ),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
  }

  async findUserFeedSubscriptions(client: PrismaClientOrTx, userId: string) {
    if (!isUuid(userId)) return [];
    try {
      return await client.feedSubscription.findMany({
        where: { userId },
        include: {
          feed: {
            select: {
              id: true,
              url: true,
              title: true,
              siteUrl: true,
              description: true,
              lastFetchedAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    } catch {
      return [];
    }
  }
}
