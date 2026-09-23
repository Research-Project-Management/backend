import { Injectable, NotFoundException, Inject, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import zlib from 'zlib';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { isUUID } from 'class-validator';
import { normalizeTags } from '../../../shared-kernel/utils/tag.utils';
import { ItemSummary } from '../../domain/types/items.types';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';

const isUuid = (val: unknown): val is string =>
  typeof val === 'string' && isUUID(val);

@Injectable()
export class QueryRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findById(
    userId: string,
    id: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
    includeContent: boolean = true,
  ) {
    if (!isUuid(id) || !isUuid(userId)) return null;
    const client = this.getClient(tx);
    const item = await client.item.findFirst({
      where: { id, deletedAt: null },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        ...(includeContent
          ? {
              notesList: {
                where: { deletedAt: null },
              },
              attachments: {
                include: { revisions: true },
              },
            }
          : {}),
      },
    });

    if (!item) return null;

    if (item.userId === userId) {
      if (projectId && isUuid(projectId) && item.projectId !== projectId) {
        return null;
      }
      return item;
    }

    if (item.projectId) {
      if (projectId && isUuid(projectId) && item.projectId !== projectId) {
        return null;
      }
      // Check project membership
      const member = await client.projectMember.findFirst({
        where: {
          projectId: item.projectId,
          userId,
        },
      });
      if (member) return item;
    }

    return null;
  }

  async findByIds(
    userId: string,
    ids: string[],
    projectId?: string,
    tx?: Prisma.TransactionClient,
    includeContent: boolean = true,
  ) {
    if (!isUuid(userId)) return [];
    const validIds = (ids || []).filter(isUuid);
    if (validIds.length === 0) return [];
    const client = this.getClient(tx);

    const scopeWhere: Prisma.ItemWhereInput =
      projectId && isUuid(projectId) ? { projectId } : { userId };

    return client.item.findMany({
      where: {
        id: { in: validIds },
        deletedAt: null,
        ...scopeWhere,
      },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        ...(includeContent
          ? {
              notesList: {
                where: { deletedAt: null },
              },
              attachments: true,
            }
          : {}),
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
    const item = await client.item.findFirst({
      where: {
        id: itemId,
        deletedAt: null,
      },
      include: {
        itemTags: { include: { tag: true } },
      },
    });

    if (
      !item ||
      ((item as any).userId && (item as any).userId !== userId)
    ) {
      return null;
    }

    const relationTags = item.itemTags.map((it: any) => it.tag.name);
    const tags = normalizeTags(relationTags);
    const meta: any = (item.metadata as any) ?? {};

    return {
      id: item.id,
      userId: item.userId,
      title: item.title,
      abstract: item.abstract,
      year: item.year,
      doi: item.doi,
      citationKey: item.citationKey,
      publicationTitle: meta.publicationTitle ?? null,
      volume: meta.volume ?? null,
      issue: meta.issue ?? null,
      pages: meta.pages ?? null,
      issn: meta.issn ?? null,
      isbn: meta.isbn ?? null,
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
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(userId)) return null;
    const client = this.getClient(tx);
    const scopeWhere =
      projectId && projectId !== 'user' ? { projectId } : { userId };
    return client.item.findFirst({
      where: {
        ...scopeWhere,
        doi,
        deletedAt: null,
      },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
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

  /**
   * Retrieves the latest itemMetadata for an item and provider (e.g. grobid, grobid_fulltext).
   */
  async findItemMetadata(
    itemId: string,
    sourceProvider: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(itemId)) return null;
    const client = this.getClient(tx);
    const record = await client.itemMetadata.findFirst({
      where: {
        itemId,
        sourceProvider,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) return null;

    // Claim Check Pattern: Transparently hydrate offloaded payload from Object Storage
    const raw = record.rawPayload as Record<string, any> | null;
    if (raw?.isOffloaded && raw?.fileId && this.storagePort?.readOwnedFile) {
      try {
        const storageFile = await this.storagePort.readOwnedFile({
          fileId: raw.fileId,
        });
        if (storageFile?.buffer) {
          const decompressed = zlib.gunzipSync(storageFile.buffer);
          const fullData = JSON.parse(decompressed.toString('utf-8'));
          return {
            ...record,
            rawPayload: {
              ...raw,
              ...fullData,
            },
          };
        }
      } catch (err: any) {
        // Fallback gracefully to summary record if storage cannot be reached
      }
    }

    return record;
  }

  async findMetadataSourceRecord(
    itemId: string,
    sourceProvider: string,
    tx?: Prisma.TransactionClient,
  ) {
    return this.findItemMetadata(itemId, sourceProvider, tx);
  }

  /**
   * Retrieves all itemMetadata records associated with an item across all providers.
   */
  async findMetadataSources(itemId: string, tx?: Prisma.TransactionClient) {
    if (!isUuid(itemId)) return [];
    const client = this.getClient(tx);
    return client.itemMetadata.findMany({
      where: { itemId },
      orderBy: { createdAt: 'desc' },
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
        | 'publications'
        | 'starred';
      userId?: string;
      collectionId?: string;
      tagId?: string;
      search?: string;
      hasFile?: boolean;
      limit?: number;
      cursor?: string;
      projectId?: string;
      orderBy?: string;
      orderDirection?: 'asc' | 'desc';
      itemType?: string;
      type?: string;
      fromYear?: number;
      toYear?: number;
      readStatus?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<any[]> {
    if (!isUuid(userId)) return [];
    const client = this.getClient(tx);
    const view = options.view ?? 'all';
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

    const effectiveUserId = options.userId || userId;

    const itemInclude = {
      contributors: {
        orderBy: { orderIndex: 'asc' as const },
      },
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
      states: effectiveUserId
        ? {
            where: { userId: effectiveUserId },
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
                  OR: this.buildSearchCondition(options.search),
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

    const sortField = options.orderBy || 'createdAt';
    const sortDir = options.orderDirection === 'asc' ? 'asc' : 'desc';
    const allowedSortFields = ['title', 'year', 'createdAt', 'updatedAt', 'citationKey'];
    const safeSortField = allowedSortFields.includes(sortField) ? sortField : 'createdAt';
    const orderByClause: any[] = [
      { [safeSortField]: sortDir },
      { id: sortDir },
    ];

    return client.item.findMany({
      where: this.buildWhereClause(userId, options),
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      orderBy: orderByClause,
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
        | 'publications'
        | 'starred';
      collectionId?: string;
      tagId?: string;
      search?: string;
      hasFile?: boolean;
      projectId?: string;
      itemType?: string;
      type?: string;
      fromYear?: number;
      toYear?: number;
      readStatus?: string;
    },
  ): Prisma.ItemWhereInput {
    const view = options.view ?? 'all';
    const hasValidProject = Boolean(
      options.projectId &&
      options.projectId !== 'user' &&
      options.projectId !== 'me' &&
      options.projectId !== 'personal' &&
      isUuid(options.projectId),
    );
    const where: any = hasValidProject
      ? { projectId: options.projectId }
      : { userId, projectId: null };

    if (view === 'trash') {
      where.deletedAt = { not: null };
    } else {
      where.deletedAt = null;
      if (view === 'unfiled') {
        where.collectionItems = { none: {} };
      } else if (view === 'my-publications' || view === 'publications') {
        where.OR = [
          { metadata: { path: ['isMyPublication'], equals: true } },
          { publications: { some: { userId } } },
        ];
      } else if (view === 'starred') {
        where.states = { some: { userId, isStarred: true } };
      }
    }

    if (options.hasFile !== undefined) {
      where.hasFile = options.hasFile;
    }

    if (options.collectionId) {
      where.collectionItems = { some: { collectionId: options.collectionId } };
    }

    if (options.tagId) {
      where.itemTags = { some: { tagId: options.tagId } };
    }

    const itemType = options.itemType || options.type;
    if (itemType) {
      if (itemType.includes(',')) {
        const types = itemType.split(',').map((t: string) => t.trim()).filter(Boolean);
        where.itemType = { in: types };
      } else {
        where.itemType = itemType;
      }
    }

    if (options.fromYear !== undefined || options.toYear !== undefined) {
      where.year = {
        ...(options.fromYear !== undefined ? { gte: Number(options.fromYear) } : {}),
        ...(options.toYear !== undefined ? { lte: Number(options.toYear) } : {}),
      };
    }

    if (options.readStatus && options.readStatus !== 'all') {
      where.states = {
        some: {
          userId,
          readStatus: options.readStatus,
        },
      };
    }

    if (options.search) {
      where.OR = this.buildSearchCondition(options.search);
    }

    return where as Prisma.ItemWhereInput;
  }

  /**
   * Constructs comprehensive search filters covering Zotero fields:
   * title, abstract, doi, publicationTitle, publisher, citationKey, arxivId,
   * isbn, issn, extra, and contributor names (fullName, lastName, firstName).
   */
  private buildSearchCondition(search: string): Prisma.ItemWhereInput[] {
    const trimmed = search.trim();
    return [
      { title: { contains: trimmed, mode: 'insensitive' } },
      { publicationTitle: { contains: trimmed, mode: 'insensitive' } },
      { abstract: { contains: trimmed, mode: 'insensitive' } },
      { doi: { contains: trimmed, mode: 'insensitive' } },
      { citationKey: { contains: trimmed, mode: 'insensitive' } },
      {
        contributors: {
          some: {
            OR: [
              { fullName: { contains: trimmed, mode: 'insensitive' } },
              { lastName: { contains: trimmed, mode: 'insensitive' } },
              { firstName: { contains: trimmed, mode: 'insensitive' } },
            ],
          },
        },
      },
    ];
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

    const effectiveUserId = options.userId || userId;
    if (view === 'recent' && effectiveUserId) {
      return client.state.count({
        where: {
          userId: effectiveUserId,
          lastReadAt: { not: null },
          item: {
            userId,
            deletedAt: null,
            ...(options.search
              ? {
                  OR: this.buildSearchCondition(options.search),
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

    const item = await client.item.findUnique({
      where: { id: itemId },
      select: { id: true, userId: true, projectId: true, deletedAt: true },
    });

    if (!item || item.deletedAt !== null) return false;

    if (!isUuid(userId) || userId === 'system') return true;

    if (projectId && projectId !== 'user' && isUuid(projectId)) {
      if (item.projectId !== projectId) return false;
      if (item.userId === userId) return true;
      const member = await client.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { role: true },
      });
      return Boolean(member);
    }

    if (item.userId === userId) return true;

    if (item.projectId) {
      const member = await client.projectMember.findUnique({
        where: { projectId_userId: { projectId: item.projectId, userId } },
        select: { role: true },
      });
      return Boolean(member);
    }

    return false;
  }

  async assertExists(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<void> {
    const isPresent = await this.exists(userId, itemId, tx, projectId);
    if (!isPresent) {
      throw new NotFoundException(`Item ${itemId} not found`);
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
      where: {
        OR: [
          { sourceItemId: itemId, targetItem: { deletedAt: null } },
          { targetItemId: itemId, sourceItem: { deletedAt: null } },
        ],
      },
      include: {
        sourceItem: {
          include: {
            contributors: {
              where: { creatorType: 'author' },
              orderBy: { orderIndex: 'asc' },
            },
          },
        },
        targetItem: {
          include: {
            contributors: {
              where: { creatorType: 'author' },
              orderBy: { orderIndex: 'asc' },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (relations && relations.length > 0) {
      const seenPeerIds = new Set<string>();
      const result: any[] = [];

      for (const r of relations) {
        const isOutgoing = r.sourceItemId === itemId;
        const peerItem = isOutgoing ? r.targetItem : r.sourceItem;
        if (!peerItem || peerItem.id === itemId) continue;
        if (seenPeerIds.has(peerItem.id)) continue;
        seenPeerIds.add(peerItem.id);

        let effectiveRelationType = r.relationType as string;
        if (!isOutgoing) {
          // Reciprocal semantic mapping when viewing from target perspective
          if (r.relationType === 'cites') {
            effectiveRelationType = 'cited_by';
          } else if (r.relationType === 'cited_by') {
            effectiveRelationType = 'cites';
          } else if (r.relationType === 'is_preprint_of') {
            effectiveRelationType = 'is_published_version_of';
          } else if (r.relationType === 'is_published_version_of') {
            effectiveRelationType = 'is_preprint_of';
          } else if (r.relationType === 'rebuts') {
            effectiveRelationType = 'rebutted_by';
          } else if (r.relationType === 'extends') {
            effectiveRelationType = 'extended_by';
          } else if (r.relationType === 'replicates') {
            effectiveRelationType = 'replicated_by';
          } else if (r.relationType === 'uses_dataset') {
            effectiveRelationType = 'dataset_used_by';
          } else if (r.relationType === 'survey_of') {
            effectiveRelationType = 'reviewed_in';
          } else if (r.relationType === 'supplements') {
            effectiveRelationType = 'supplemented_by';
          } else if (r.relationType === 'is_translation_of') {
            effectiveRelationType = 'translated_as';
          }
        }

        const authorNames = (peerItem.contributors || [])
          .map(
            (c: any) =>
              c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          )
          .filter(Boolean);

        result.push({
          id: peerItem.id,
          relationId: r.id,
          targetItemId: peerItem.id,
          title: peerItem.title || 'Untitled Item',
          authors: authorNames,
          year: peerItem.year,
          doi: peerItem.doi,
          itemType: (peerItem as any).type || (peerItem as any).itemType,
          citationKey: peerItem.citationKey,
          relationType: effectiveRelationType,
          direction: isOutgoing ? 'outgoing' : 'incoming',
          description: r.description || '',
          linkedAt: r.createdAt ? r.createdAt.toISOString() : undefined,
          targetItem: peerItem,
        });
      }

      if (result.length > 0) {
        return result;
      }
    }

    const item = await client.item.findUnique({
      where: { id: itemId },
      select: { metadata: true },
    });
    if (!item || !item.metadata) return [];
    try {
      const meta = (item.metadata as any) ?? {};
      return Array.isArray(meta.relations) ? meta.relations : [];
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
        metadata: true,
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
        metadata: true,
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

    const sourceRecord = await client.itemMetadata.findFirst({
      where: {
        itemId: itemId,
        sourceProvider: 'grobid_fulltext',
      },
      orderBy: { fetchedAt: 'desc' },
    });

    return sourceRecord?.rawPayload || null;
  }

  async findProjectWithMembers(
    projectId: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(projectId)) return null;
    const client = this.getClient(tx);
    return client.project.findUnique({
      where: { id: projectId },
      include: { members: true },
    });
  }

  async findDuplicateInProject(
    projectId: string,
    criteria: {
      doi?: string | null;
      citationKey?: string | null;
      title: string;
    },
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(projectId)) return null;
    const client = this.getClient(tx);
    return client.item.findFirst({
      where: {
        projectId,
        deletedAt: null,
        OR: [
          ...(criteria.doi ? [{ doi: criteria.doi }] : []),
          ...(criteria.citationKey
            ? [{ citationKey: criteria.citationKey }]
            : []),
          { title: criteria.title },
        ],
      },
    });
  }
}

export { QueryRepository as ItemQueryRepository };
