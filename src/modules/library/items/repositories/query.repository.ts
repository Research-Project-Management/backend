import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../core/database/prisma.service';
import { isUUID } from 'class-validator';
import { normalizeTags } from '../../tags/utils/tags.utils';
import { ItemSummary } from '../types/items.types';

const isUuid = (val: unknown): val is string =>
  typeof val === 'string' && isUUID(val);

@Injectable()
export class QueryRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findById(
    userId: string,
    id: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(id)) return null;
    const client = this.getClient(tx);
    const where: any = { id, deletedAt: null };
    if (projectId && isUuid(projectId)) {
      where.projectId = projectId;
    } else if (isUuid(userId)) {
      where.userId = userId;
    }
    return client.item.findFirst({
      where,
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
        user: {
          select: {
            id: true,
            name: true,
            avatar: true,
            email: true,
          },
        },
      },
    });
  }

  async findByIds(
    userId: string,
    ids: string[],
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(userId)) return [];
    const validIds = (ids || []).filter(isUuid);
    if (validIds.length === 0) return [];
    const client = this.getClient(tx);
    return client.item.findMany({
      where: {
        id: { in: validIds },
        userId,
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
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(itemId) || !isUuid(userId)) return null;
    const client = this.getClient(tx);
    const item = await client.item.findUnique({
      where: { id: itemId },
      include: {
        itemTags: { include: { tag: true } },
      },
    });

    if (!item || ((item as any).userId && (item as any).userId !== userId) || item.deletedAt) {
      return null;
    }

    const relationTags = item.itemTags.map((it: any) => it.tag.name);
    const tags = normalizeTags(relationTags);

    return {
      id: item.id,
      userId: item.userId,
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
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(userId)) return [];
    const validIds = (itemIds || []).filter(isUuid);
    if (validIds.length === 0) return [];

    const client = this.getClient(tx);
    return client.item.findMany({
      where: {
        userId,
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
    userId: string,
    doi: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(userId)) return null;
    const client = this.getClient(tx);
    return client.item.findFirst({
      where: {
        userId,
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
    userId: string,
    options: {
      view?:
        | 'all'
        | 'recent'
        | 'unfiled'
        | 'trash'
        | 'my-publications'
        | 'publications';
      userId?: string;
      collectionId?: string;
      tagId?: string;
      search?: string;
      limit?: number;
      cursor?: string;
      projectId?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<any[]> {
    if (!isUuid(userId)) return [];
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
      user: {
        select: {
          id: true,
          name: true,
          avatar: true,
          email: true,
        },
      },
      states: options.userId
        ? {
            where: { userId: options.userId },
          }
        : false,
    };

    if (view === 'recent' && options.userId) {
      let cursorLastReadAt: Date | undefined;
      if (options.cursor) {
        const cursorState = await client.state.findFirst({
          where: { userId: options.userId, itemId: options.cursor },
          select: { lastReadAt: true },
        });
        cursorLastReadAt = cursorState?.lastReadAt ?? undefined;
      }

      const userStates = await client.state.findMany({
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
            ...(options.projectId
              ? { projectId: options.projectId }
              : { userId }),
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
                    {
                      publicationTitle: {
                        contains: options.search,
                        mode: 'insensitive',
                      },
                    },
                    {
                      citationKey: {
                        contains: options.search,
                        mode: 'insensitive',
                      },
                    },
                    {
                      contributors: {
                        some: {
                          fullName: {
                            contains: options.search,
                            mode: 'insensitive',
                          },
                        },
                      },
                    },
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
          } as any,
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
        .filter((us: any) => Boolean(us.item))
        .map((us: any) => ({
          ...us.item,
          lastReadAt: us.lastReadAt,
        }));
    }

    return client.item.findMany({
      where: this.buildWhereClause(userId, options),
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
    userId: string,
    options: {
      view?:
        | 'all'
        | 'recent'
        | 'unfiled'
        | 'trash'
        | 'my-publications'
        | 'publications';
      collectionId?: string;
      tagId?: string;
      search?: string;
      projectId?: string;
    },
  ): Prisma.ItemWhereInput {
    const view = options.view ?? 'all';
    const where: any = options.projectId
      ? { projectId: options.projectId }
      : { userId };

    if (view === 'trash') {
      where.deletedAt = { not: null };
    } else {
      where.deletedAt = null;
      if (view === 'unfiled') {
        where.collectionItems = { none: {} };
      } else if (view === 'my-publications' || view === 'publications') {
        where.isMyPublication = true;
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
        { publicationTitle: { contains: options.search, mode: 'insensitive' } },
        { citationKey: { contains: options.search, mode: 'insensitive' } },
        {
          contributors: {
            some: { fullName: { contains: options.search, mode: 'insensitive' } },
          },
        },
      ];
    }

    return where as Prisma.ItemWhereInput;
  }

  async count(
    userId: string,
    options: {
      view?:
        | 'all'
        | 'recent'
        | 'unfiled'
        | 'trash'
        | 'my-publications'
        | 'publications';
      userId?: string;
      collectionId?: string;
      tagId?: string;
      search?: string;
      projectId?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (!isUuid(userId)) return 0;
    const client = this.getClient(tx);
    const view = options.view ?? 'all';

    if (view === 'recent' && options.userId) {
      return client.state.count({
        where: {
          userId: options.userId,
          lastReadAt: { not: null },
          item: {
            userId,
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
                    {
                      publicationTitle: {
                        contains: options.search,
                        mode: 'insensitive',
                      },
                    },
                    {
                      citationKey: {
                        contains: options.search,
                        mode: 'insensitive',
                      },
                    },
                    {
                      contributors: {
                        some: {
                          fullName: {
                            contains: options.search,
                            mode: 'insensitive',
                          },
                        },
                      },
                    },
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
          } as any,
        },
      });
    }

    return client.item.count({
      where: this.buildWhereClause(userId, options),
    });
  }

  async exists(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<boolean> {
    if (!isUuid(itemId)) return false;
    const client = this.getClient(tx);
    const scopeWhere =
      projectId && projectId !== 'user' && isUuid(projectId)
        ? { projectId }
        : isUuid(userId)
          ? { userId }
          : null;
    if (!scopeWhere) return false;
    const count = await client.item.count({
      where: { id: itemId, ...scopeWhere, deletedAt: null },
    });
    return count > 0;
  }

  async assertExists(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<void> {
    const isPresent = await this.exists(userId, itemId, tx, projectId);
    if (!isPresent) {
      throw new NotFoundException(
        `Item ${itemId} not found`,
      );
    }
  }

  async existMany(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (!itemIds || itemIds.length === 0) return result;
    const scopeWhere =
      projectId && projectId !== 'user' && isUuid(projectId)
        ? { projectId }
        : isUuid(userId)
          ? { userId }
          : null;
    if (!scopeWhere) {
      for (const id of itemIds) result.set(id, false);
      return result;
    }

    const validIds = itemIds.filter(isUuid);
    const client = this.getClient(tx);
    const found = await client.item.findMany({
      where: { id: { in: validIds }, ...scopeWhere, deletedAt: null },
      select: { id: true },
    });
    const foundSet = new Set(found.map((it: any) => it.id));
    for (const id of itemIds) {
      result.set(id, foundSet.has(id));
    }
    return result;
  }

  async findSummaryById(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<ItemSummary | null> {
    if (!isUuid(itemId)) return null;
    const client = this.getClient(tx);
    const scopeWhere =
      projectId && projectId !== 'user' && isUuid(projectId)
        ? { projectId }
        : isUuid(userId)
          ? { userId }
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
        (c: any) =>
          c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      ),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  async findSummariesByIds(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<ItemSummary[]> {
    if (!itemIds || itemIds.length === 0 || !isUuid(userId)) return [];
    const validIds = itemIds.filter(isUuid);
    if (validIds.length === 0) return [];

    const client = this.getClient(tx);
    const items = await client.item.findMany({
      where: { id: { in: validIds }, userId, deletedAt: null },
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

    return items.map((item: any) => ({
      id: item.id,
      userId: item.userId,
      title: item.title,
      itemType: item.itemType || undefined,
      year: item.year,
      doi: item.doi || null,
      primaryAuthors: item.contributors.map(
        (c: any) =>
          c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
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
    const item = await client.item.findUnique({
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
    userId: string,
    limit: number = 2000,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(userId)) return [];
    const client = this.getClient(tx);
    return client.item.findMany({
      where: { userId, deletedAt: null },
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
    userId: string,
    limit: number = 2000,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(userId)) return [];
    const client = this.getClient(tx);
    return client.item.findMany({
      where: { userId, deletedAt: null },
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
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(itemId) || !isUuid(userId)) return null;
    const client = this.getClient(tx);
    const item = await client.item.findFirst({
      where: { id: itemId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!item) return null;

    const sourceRecord = await client.metadataSourceRecord.findFirst({
      where: {
        itemId: itemId,
        sourceProvider: 'grobid_fulltext',
      },
      orderBy: { fetchedAt: 'desc' },
    });

    return sourceRecord?.rawPayload || null;
  }
}

export { QueryRepository as ItemQueryRepository };
