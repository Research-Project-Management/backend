import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../core/database/prisma.service';
import { isUuid } from '../../../../core/utils/tenant.util';
import { normalizeTags } from '../../tags/utils/tags.utils';
import { CatalogItemSummary } from '../types/items.types';

@Injectable()
export class QueryRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findById(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(id) || !isUuid(workspaceId)) return null;
    const client = this.getClient(tx);
    return client.catalogItem.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        identifiers: true,
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        notesList: {
          where: { deletedAt: null },
        },
        attachments: {
          include: { revisions: true },
        },
      },
    });
  }

  async findByIds(
    workspaceId: string,
    ids: string[],
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(workspaceId)) return [];
    const validIds = (ids || []).filter(isUuid);
    if (validIds.length === 0) return [];
    const client = this.getClient(tx);
    return client.catalogItem.findMany({
      where: {
        id: { in: validIds },
        workspaceId,
        deletedAt: null,
      },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        identifiers: true,
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        notesList: {
          where: { deletedAt: null },
        },
        attachments: true,
      },
    });
  }

  async getItemSnapshot(
    workspaceId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(itemId) || !isUuid(workspaceId)) return null;
    const client = this.getClient(tx);
    const item = await client.catalogItem.findUnique({
      where: { id: itemId },
      include: {
        itemTags: { include: { tag: true } },
      },
    });

    if (!item || item.workspaceId !== workspaceId || item.deletedAt) {
      return null;
    }

    const relationTags = item.itemTags.map((it) => it.tag.name);
    const tags = normalizeTags(relationTags);

    return {
      id: item.id,
      workspaceId: item.workspaceId,
      title: item.title,
      abstract: item.abstract,
      year: item.year,
      doi: item.doi,
      citationKey: item.citationKey,
      publicationTitle: item.publicationTitle,
      volume: item.volume,
      issue: item.issue,
      pages: item.pages,
      issn: item.issn,
      isbn: item.isbn,
      url: item.url,
      tags,
    };
  }

  async getItemSnapshots(
    workspaceId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(workspaceId)) return [];
    const validIds = (itemIds || []).filter(isUuid);
    if (validIds.length === 0) return [];

    const client = this.getClient(tx);
    return client.catalogItem.findMany({
      where: {
        workspaceId,
        id: { in: validIds },
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        itemType: true,
        version: true,
        updatedAt: true,
      },
    });
  }

  async findByDoi(
    workspaceId: string,
    doi: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(workspaceId)) return null;
    const client = this.getClient(tx);
    return client.catalogItem.findFirst({
      where: {
        workspaceId,
        doi,
        deletedAt: null,
      },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        identifiers: true,
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        attachments: true,
      },
    });
  }

  async findMany(
    workspaceId: string,
    options: {
      view?: 'all' | 'recent' | 'unfiled' | 'trash';
      userId?: string;
      collectionId?: string;
      tagId?: string;
      search?: string;
      limit?: number;
      cursor?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<any[]> {
    if (!isUuid(workspaceId)) return [];
    const client = this.getClient(tx);
    const view = options.view ?? 'all';
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

    const itemInclude = {
      contributors: {
        orderBy: { orderIndex: 'asc' as const },
      },
      identifiers: true,
      collectionItems: {
        include: { collection: true },
      },
      itemTags: {
        include: { tag: true },
      },
      attachments: true,
      notesList: {
        where: { deletedAt: null },
      },
      userStates: options.userId
        ? {
            where: { userId: options.userId },
          }
        : false,
    };

    if (view === 'recent' && options.userId) {
      // For recent view, cursor-based pagination uses itemId (catalogItem.id).
      // Since userItemState has no unique constraint on itemId alone, we resolve
      // the cursor to a lastReadAt timestamp and use that for keyset pagination.
      let cursorLastReadAt: Date | undefined;
      if (options.cursor) {
        const cursorState = await client.userItemState.findFirst({
          where: { userId: options.userId, itemId: options.cursor },
          select: { lastReadAt: true },
        });
        cursorLastReadAt = cursorState?.lastReadAt ?? undefined;
      }

      const userStates = await client.userItemState.findMany({
        where: {
          userId: options.userId,
          ...(cursorLastReadAt
            ? {
                OR: [
                  { lastReadAt: { lt: cursorLastReadAt } },
                  {
                    lastReadAt: cursorLastReadAt,
                    itemId: { lt: options.cursor },
                  },
                ],
              }
            : { lastReadAt: { not: null } }),
          item: {
            workspaceId,
            deletedAt: null,
            ...(options.search
              ? {
                  OR: [
                    {
                      title: { contains: options.search, mode: 'insensitive' },
                    },
                    {
                      abstract: {
                        contains: options.search,
                        mode: 'insensitive',
                      },
                    },
                    { doi: { contains: options.search, mode: 'insensitive' } },
                  ],
                }
              : {}),
            ...(options.collectionId
              ? {
                  collectionItems: {
                    some: { collectionId: options.collectionId },
                  },
                }
              : {}),
            ...(options.tagId
              ? {
                  itemTags: {
                    some: { tagId: options.tagId },
                  },
                }
              : {}),
          },
        },
        include: {
          item: {
            include: itemInclude,
          },
        },
        orderBy: [{ lastReadAt: 'desc' }, { itemId: 'desc' }],
        take: limit + 1,
      });

      return userStates
        .filter((us) => Boolean(us.item))
        .map((us) => ({
          ...us.item,
          lastReadAt: us.lastReadAt,
        }));
    }

    return client.catalogItem.findMany({
      where: this.buildWhereClause(workspaceId, options),
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: itemInclude,
    });
  }

  /**
   * Builds a shared CatalogItem WHERE clause from the common filter options.
   * Used by both findMany and count to avoid duplicated logic.
   */
  buildWhereClause(
    workspaceId: string,
    options: {
      view?: 'all' | 'recent' | 'unfiled' | 'trash';
      collectionId?: string;
      tagId?: string;
      search?: string;
    },
  ): Prisma.CatalogItemWhereInput {
    const view = options.view ?? 'all';
    const where: Prisma.CatalogItemWhereInput = { workspaceId };

    if (view === 'trash') {
      where.deletedAt = { not: null };
    } else {
      where.deletedAt = null;
      if (view === 'unfiled') {
        where.collectionItems = { none: {} };
      }
    }

    if (options.collectionId) {
      where.collectionItems = { some: { collectionId: options.collectionId } };
    }

    if (options.tagId) {
      where.itemTags = { some: { tagId: options.tagId } };
    }

    if (options.search) {
      where.OR = [
        { title: { contains: options.search, mode: 'insensitive' } },
        { abstract: { contains: options.search, mode: 'insensitive' } },
        { doi: { contains: options.search, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  async count(
    workspaceId: string,
    options: {
      view?: 'all' | 'recent' | 'unfiled' | 'trash';
      userId?: string;
      collectionId?: string;
      tagId?: string;
      search?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (!isUuid(workspaceId)) return 0;
    const client = this.getClient(tx);
    const view = options.view ?? 'all';

    if (view === 'recent' && options.userId) {
      return client.userItemState.count({
        where: {
          userId: options.userId,
          lastReadAt: { not: null },
          item: {
            workspaceId,
            deletedAt: null,
            ...(options.search
              ? {
                  OR: [
                    {
                      title: { contains: options.search, mode: 'insensitive' },
                    },
                    {
                      abstract: {
                        contains: options.search,
                        mode: 'insensitive',
                      },
                    },
                    { doi: { contains: options.search, mode: 'insensitive' } },
                  ],
                }
              : {}),
            ...(options.collectionId
              ? {
                  collectionItems: {
                    some: { collectionId: options.collectionId },
                  },
                }
              : {}),
            ...(options.tagId
              ? {
                  itemTags: {
                    some: { tagId: options.tagId },
                  },
                }
              : {}),
          },
        },
      });
    }

    return client.catalogItem.count({
      where: this.buildWhereClause(workspaceId, options),
    });
  }

  async exists(
    workspaceId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (!isUuid(itemId) || !isUuid(workspaceId)) return false;
    const client = this.getClient(tx);
    const count = await client.catalogItem.count({
      where: { id: itemId, workspaceId, deletedAt: null },
    });
    return count > 0;
  }

  async assertExists(
    workspaceId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const isPresent = await this.exists(workspaceId, itemId, tx);
    if (!isPresent) {
      throw new NotFoundException(
        `Item ${itemId} not found in workspace ${workspaceId}`,
      );
    }
  }

  async existMany(
    workspaceId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (!itemIds || itemIds.length === 0) return result;
    if (!isUuid(workspaceId)) {
      for (const id of itemIds) result.set(id, false);
      return result;
    }

    const validIds = itemIds.filter(isUuid);
    const client = this.getClient(tx);
    const found = await client.catalogItem.findMany({
      where: { id: { in: validIds }, workspaceId, deletedAt: null },
      select: { id: true },
    });
    const foundSet = new Set(found.map((it) => it.id));
    for (const id of itemIds) {
      result.set(id, foundSet.has(id));
    }
    return result;
  }

  async findSummaryById(
    workspaceId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CatalogItemSummary | null> {
    if (!isUuid(itemId) || !isUuid(workspaceId)) return null;
    const client = this.getClient(tx);
    const item = await client.catalogItem.findFirst({
      where: { id: itemId, workspaceId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
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
      workspaceId: item.workspaceId,
      title: item.title,
      itemType: item.itemType || undefined,
      year: item.year,
      doi: item.doi || null,
      primaryAuthors: item.contributors.map(
        (c) => c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      ),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  async findSummariesByIds(
    workspaceId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<CatalogItemSummary[]> {
    if (!itemIds || itemIds.length === 0 || !isUuid(workspaceId)) return [];
    const validIds = itemIds.filter(isUuid);
    if (validIds.length === 0) return [];

    const client = this.getClient(tx);
    const items = await client.catalogItem.findMany({
      where: { id: { in: validIds }, workspaceId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
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
      workspaceId: item.workspaceId,
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

  async getRelations(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<any[]> {
    if (!isUuid(itemId)) return [];
    const client = this.getClient(tx);
    const relations = await client.itemRelation.findMany({
      where: { sourceItemId: itemId },
      include: { targetItem: true },
    });
    if (relations && relations.length > 0) {
      return relations.map((r) => ({
        id: r.id,
        targetItemId: r.targetItemId,
        relationType: r.relationType,
        description: r.description,
        targetItem: r.targetItem,
      }));
    }
    const item = await client.catalogItem.findUnique({
      where: { id: itemId },
      select: { extra: true },
    });
    if (!item || !item.extra) return [];
    try {
      const parsed = JSON.parse(item.extra);
      return Array.isArray(parsed.relations) ? parsed.relations : [];
    } catch {
      return [];
    }
  }

  async findQualityAuditItems(
    workspaceId: string,
    limit: number = 2000,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(workspaceId)) return [];
    const client = this.getClient(tx);
    return client.catalogItem.findMany({
      where: { workspaceId, deletedAt: null },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        doi: true,
        abstract: true,
        year: true,
        contributors: {
          where: { creatorType: 'author' },
          select: { id: true },
        },
        publicationTitle: true,
      },
    });
  }

  async findDuplicateCandidateItems(
    workspaceId: string,
    limit: number = 2000,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(workspaceId)) return [];
    const client = this.getClient(tx);
    return client.catalogItem.findMany({
      where: { workspaceId, deletedAt: null },
      select: {
        id: true,
        title: true,
        doi: true,
        isbn: true,
        issn: true,
        pmid: true,
        citationKey: true,
        year: true,
        contributors: {
          where: { creatorType: 'author' },
          select: {
            fullName: true,
            firstName: true,
            lastName: true,
            orderIndex: true,
          },
          orderBy: { orderIndex: 'asc' },
        },
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getFulltext(
    workspaceId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(itemId) || !isUuid(workspaceId)) return null;
    const client = this.getClient(tx);
    const item = await client.catalogItem.findFirst({
      where: { id: itemId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!item) return null;

    const sourceRecord = await client.metadataSourceRecord.findFirst({
      where: {
        catalogItemId: itemId,
        sourceProvider: 'grobid_fulltext',
      },
      orderBy: { fetchedAt: 'desc' },
    });

    return sourceRecord?.rawPayload || null;
  }
}

export { QueryRepository as ItemQueryRepository };
