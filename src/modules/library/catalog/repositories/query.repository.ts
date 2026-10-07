import {
  Injectable,
  NotFoundException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import zlib from 'zlib';
import { PrismaService } from '../../../../core/database/prisma.service';
import { isUUID } from 'class-validator';
import { normalizeTags } from '../../shared-kernel/utils/tag.utils';
import { ItemSummary } from '../types/items.types';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { TreeEngine } from '../utils/tree.engine';

const isUuid = (val: unknown): val is string =>
  typeof val === 'string' && isUUID(val);

@Injectable()
export class QueryRepository {
  private readonly treeEngine = new TreeEngine();

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
    includeDeleted: boolean = false,
  ): Promise<any> {
    if (!isUuid(id) || !isUuid(userId)) return null;
    const client = this.getClient(tx);
    const item = await client.item.findFirst({
      where: {
        id,
        ...(includeDeleted ? {} : { deletedAt: null }),
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
              attachments: {
                include: { revisions: true },
              },
            }
          : {}),
      },
    });

    if (!item) {
      if (!includeDeleted) {
        const tombstone = await client.item.findUnique({
          where: { id },
          select: { metadata: true, deletedAt: true },
        });
        const targetId = (tombstone?.metadata as any)?.mergedIntoId;
        if (targetId && isUuid(targetId) && targetId !== id) {
          return this.findById(
            userId,
            targetId,
            projectId,
            tx,
            includeContent,
            false,
          );
        }
      }
      return null;
    }

    const isProjectScope = Boolean(projectId && isUuid(projectId));

    if (isProjectScope) {
      if (item.projectId !== projectId) return null;
      if (item.userId === userId) return item;
      const member = await client.projectMember.findFirst({
        where: {
          projectId,
          userId,
        },
      });
      if (member) return item;
      return null;
    }

    if (item.userId === userId) {
      return item;
    }

    if (item.projectId) {
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
      projectId && isUuid(projectId)
        ? { projectId }
        : { userId, projectId: null };

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

    if (!item || ((item as any).userId && (item as any).userId !== userId)) {
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
    const scopeWhere: Prisma.ItemWhereInput =
      projectId && projectId !== 'user' && isUuid(projectId)
        ? { projectId }
        : { userId, projectId: null };
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

  /**
   * Resolves target collection IDs taking into account subcollection inheritance.
   * If options.collectionIds is explicitly provided, it is returned.
   * If options.collectionId is provided:
   *   - If includeSubcollections !== false and recursive !== false:
   *       queries all collections in scope to find descendants and returns [collectionId, ...descendantIds].
   *   - Otherwise, returns [collectionId].
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
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<string[] | undefined> {
    if (options.collectionIds && options.collectionIds.length > 0) {
      return options.collectionIds;
    }

    if (!options.collectionId) {
      return undefined;
    }

    // Default to true matching Zotero's canonical recursiveCollections preference
    const isRecursive =
      options.includeSubcollections !== false && options.recursive !== false;

    if (!isRecursive) {
      return [options.collectionId];
    }

    const hasValidProject = Boolean(
      options.projectId &&
      options.projectId !== 'user' &&
      options.projectId !== 'me' &&
      options.projectId !== 'personal' &&
      isUuid(options.projectId),
    );

    const scopeWhere: Prisma.CollectionWhereInput = hasValidProject
      ? { projectId: options.projectId, deletedAt: null }
      : { userId, projectId: null, deletedAt: null };

    const allCollections = await client.collection.findMany({
      where: scopeWhere,
      select: { id: true, parentId: true },
    });

    const descendantIds = this.treeEngine.getDescendantIds(
      allCollections as any,
      options.collectionId,
    );

    return [options.collectionId, ...descendantIds];
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
        | 'starred'
        | 'retracted';
      userId?: string;
      collectionId?: string;
      collectionIds?: string[];
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
    },
    tx?: Prisma.TransactionClient,
  ): Promise<any[]> {
    if (!isUuid(userId)) return [];
    const client = this.getClient(tx);
    const view = options.view ?? 'all';
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

    const effectiveUserId = options.userId || userId;

    const targetCollectionIds = await this.resolveTargetCollectionIds(
      userId,
      options,
      client,
    );

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
      attachments: {
        select: {
          id: true,
          itemId: true,
          linkMode: true,
          attachmentType: true,
          filename: true,
          url: true,
          fileHash: true,
          fileId: true,
          storageKey: true,
          mimeType: true,
          size: true,
          pageCount: true,
          extractionStatus: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
        },
      },
      ...(options.includeNotes
        ? {
            notesList: {
              where: { deletedAt: null },
            },
          }
        : {}),
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
              : { userId, projectId: null }),
            deletedAt: null,
            ...(options.search
              ? {
                  OR: this.buildSearchCondition(options.search),
                }
              : {}),
            ...(targetCollectionIds && targetCollectionIds.length > 0
              ? {
                  collectionItems: {
                    some: {
                      collectionId:
                        targetCollectionIds.length === 1
                          ? targetCollectionIds[0]
                          : { in: targetCollectionIds },
                    },
                  },
                }
              : options.collectionId
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
        ...(options.cursor
          ? { skip: 1 }
          : options.page && options.page > 1
            ? { skip: (options.page - 1) * limit }
            : {}),
      });

      return userStates
        .filter((us: any) => Boolean(us.item))
        .map((us: any) => ({
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
    const orderByClause: any[] = [
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
        | 'starred'
        | 'retracted';
      collectionId?: string;
      collectionIds?: string[];
      targetCollectionIds?: string[];
      tagId?: string;
      tag?: string;
      search?: string;
      hasFile?: boolean;
      hasNotes?: boolean;
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

    const andConditions: Prisma.ItemWhereInput[] = [];

    if (view === 'trash') {
      where.deletedAt = { not: null };
    } else {
      where.deletedAt = null;
      if (view === 'unfiled') {
        where.collectionItems = { none: {} };
      } else if (view === 'my-publications' || view === 'publications') {
        andConditions.push({
          OR: [
            { metadata: { path: ['isMyPublication'], equals: true } },
            { publications: { some: { userId } } },
          ],
        });
      } else if (view === 'starred') {
        where.states = { some: { userId, isStarred: true } };
      } else if (view === 'retracted') {
        andConditions.push({
          metadata: { path: ['isRetracted'], equals: true },
        });
      }
    }

    if (options.hasFile !== undefined) {
      where.hasFile = options.hasFile;
    }

    if (options.hasNotes !== undefined) {
      if (options.hasNotes) {
        where.noteCount = { gt: 0 };
      } else {
        where.noteCount = 0;
      }
    }

    const targetCollectionIds =
      options.targetCollectionIds || options.collectionIds;
    if (targetCollectionIds && targetCollectionIds.length > 0) {
      if (targetCollectionIds.length === 1) {
        where.collectionItems = {
          some: { collectionId: targetCollectionIds[0] },
        };
      } else {
        where.collectionItems = {
          some: { collectionId: { in: targetCollectionIds } },
        };
      }
    } else if (options.collectionId) {
      where.collectionItems = { some: { collectionId: options.collectionId } };
    }

    if (options.tagId) {
      where.itemTags = { some: { tagId: options.tagId } };
    }

    if (options.tag) {
      const tagNames = options.tag
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (tagNames.length > 0) {
        where.itemTags = {
          some: {
            tag: {
              OR: tagNames.map((name) => ({
                name: { equals: name, mode: 'insensitive' as const },
              })),
            },
          },
        };
      }
    }

    const itemType = options.itemType || options.type;
    if (itemType) {
      if (itemType.includes(',')) {
        const types = itemType
          .split(',')
          .map((t: string) => t.trim())
          .filter(Boolean);
        where.itemType = { in: types };
      } else {
        where.itemType = itemType;
      }
    }

    if (options.fromYear !== undefined || options.toYear !== undefined) {
      where.year = {
        ...(options.fromYear !== undefined
          ? { gte: Number(options.fromYear) }
          : {}),
        ...(options.toYear !== undefined
          ? { lte: Number(options.toYear) }
          : {}),
      };
    }

    if (options.readStatus && options.readStatus !== 'all') {
      const statuses = options.readStatus
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length > 0) {
        where.states = {
          some: {
            userId,
            readStatus:
              statuses.length > 1
                ? { in: statuses as any }
                : (statuses[0] as any),
          },
        };
      }
    }

    if (options.search) {
      andConditions.push({
        OR: this.buildSearchCondition(options.search),
      });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
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
        | 'publications'
        | 'starred'
        | 'retracted';
      userId?: string;
      collectionId?: string;
      collectionIds?: string[];
      includeSubcollections?: boolean;
      recursive?: boolean;
      tagId?: string;
      tag?: string;
      search?: string;
      hasFile?: boolean;
      hasNotes?: boolean;
      projectId?: string;
      itemType?: string;
      type?: string;
      fromYear?: number;
      toYear?: number;
      readStatus?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (!isUuid(userId)) return 0;
    const client = this.getClient(tx);
    const view = options.view ?? 'all';

    const targetCollectionIds = await this.resolveTargetCollectionIds(
      userId,
      options,
      client,
    );

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
            ...(targetCollectionIds && targetCollectionIds.length > 0
              ? {
                  collectionItems: {
                    some: {
                      collectionId:
                        targetCollectionIds.length === 1
                          ? targetCollectionIds[0]
                          : { in: targetCollectionIds },
                    },
                  },
                }
              : options.collectionId
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
      where: this.buildWhereClause(userId, { ...options, targetCollectionIds }),
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
          ? { userId, projectId: null }
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
    projectIdOrTx?: string | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ): Promise<ItemSummary[]> {
    if (!itemIds || itemIds.length === 0 || !isUuid(userId)) return [];
    const validIds = itemIds.filter(isUuid);
    if (validIds.length === 0) return [];

    const projectId =
      typeof projectIdOrTx === 'string' && isUuid(projectIdOrTx)
        ? projectIdOrTx
        : undefined;
    const client = this.getClient(
      typeof projectIdOrTx === 'object' ? projectIdOrTx : tx,
    );
    const scopeWhere: Prisma.ItemWhereInput = projectId
      ? { projectId }
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
    userId?: string,
    limit: number = 2000,
    projectIdOrTx?: string | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    const projectId =
      typeof projectIdOrTx === 'string' && isUuid(projectIdOrTx)
        ? projectIdOrTx
        : undefined;
    const client = this.getClient(
      typeof projectIdOrTx === 'object' ? projectIdOrTx : tx,
    );
    let scopeWhere: Prisma.ItemWhereInput = { deletedAt: null };
    if (projectId) {
      scopeWhere = { projectId, deletedAt: null };
    } else if (userId && isUuid(userId)) {
      scopeWhere = { userId, projectId: null, deletedAt: null };
    } else if (userId && !isUuid(userId)) {
      return [];
    }

    return client.item.findMany({
      where: scopeWhere,
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
    userId?: string,
    limit?: number,
    projectIdOrTx?: string | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    const projectId =
      typeof projectIdOrTx === 'string' && isUuid(projectIdOrTx)
        ? projectIdOrTx
        : undefined;
    const client = this.getClient(
      typeof projectIdOrTx === 'object' ? projectIdOrTx : tx,
    );
    let scopeWhere: Prisma.ItemWhereInput = { deletedAt: null };
    if (projectId) {
      scopeWhere = { projectId, deletedAt: null };
    } else if (userId && isUuid(userId)) {
      scopeWhere = { userId, projectId: null, deletedAt: null };
    } else if (userId && !isUuid(userId)) {
      return [];
    }

    return client.item.findMany({
      where: scopeWhere,
      select: {
        id: true,
        title: true,
        itemType: true,
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
      ...(limit && limit > 0 ? { take: limit } : {}),
      orderBy: { createdAt: 'desc' },
    });
  }

  async getFulltext(
    userId: string,
    itemId: string,
    projectIdOrTx?: string | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(itemId) || !isUuid(userId)) return null;
    const projectId =
      typeof projectIdOrTx === 'string' && isUuid(projectIdOrTx)
        ? projectIdOrTx
        : undefined;
    const client = this.getClient(
      typeof projectIdOrTx === 'object' ? projectIdOrTx : tx,
    );
    const scopeWhere: Prisma.ItemWhereInput = projectId
      ? { projectId }
      : { userId, projectId: null };
    const item = await client.item.findFirst({
      where: { id: itemId, ...scopeWhere, deletedAt: null },
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

  async findProjectMember(
    projectId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(projectId) || !isUuid(userId)) return null;
    const client = this.getClient(tx);
    return client.projectMember.findFirst({
      where: { projectId, userId },
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

  async findDuplicatesInProject(
    projectId: string,
    criteriaList: Array<{
      doi?: string | null;
      citationKey?: string | null;
      title?: string | null;
    }>,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(projectId) || !criteriaList?.length) return [];
    const client = this.getClient(tx);

    const dois = criteriaList
      .map((c) => c.doi?.trim())
      .filter((d): d is string => Boolean(d));
    const citationKeys = criteriaList
      .map((c) => c.citationKey?.trim())
      .filter((k): k is string => Boolean(k));
    const titles = criteriaList
      .map((c) => c.title?.trim())
      .filter((t): t is string => Boolean(t));

    const orConditions: Prisma.ItemWhereInput[] = [];
    if (dois.length > 0) orConditions.push({ doi: { in: dois } });
    if (citationKeys.length > 0)
      orConditions.push({ citationKey: { in: citationKeys } });
    if (titles.length > 0) orConditions.push({ title: { in: titles } });

    if (orConditions.length === 0) return [];

    return client.item.findMany({
      where: {
        projectId,
        deletedAt: null,
        OR: orConditions,
      },
      select: {
        id: true,
        doi: true,
        citationKey: true,
        title: true,
      },
    });
  }

  async findByCitationKey(
    userId: string,
    citationKey: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!citationKey?.trim()) return null;
    const client = this.getClient(tx);
    const scopeWhere: Prisma.ItemWhereInput =
      projectId && isUuid(projectId)
        ? { projectId, deletedAt: null }
        : { userId, projectId: null, deletedAt: null };

    return client.item.findFirst({
      where: {
        citationKey: { equals: citationKey.trim(), mode: 'insensitive' },
        ...scopeWhere,
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        itemTags: { include: { tag: true } },
        collectionItems: { include: { collection: true } },
        attachments: { include: { revisions: true } },
        notesList: { where: { deletedAt: null } },
      },
    });
  }

  async findByCitationKeys(
    userId: string,
    citationKeys: string[],
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    const cleanKeys = (citationKeys || [])
      .map((k) => k?.trim())
      .filter((k): k is string => Boolean(k));
    if (cleanKeys.length === 0) return [];
    const client = this.getClient(tx);
    const scopeWhere: Prisma.ItemWhereInput =
      projectId && isUuid(projectId)
        ? { projectId, deletedAt: null }
        : { userId, projectId: null, deletedAt: null };

    return client.item.findMany({
      where: {
        citationKey: { in: cleanKeys, mode: 'insensitive' },
        ...scopeWhere,
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        itemTags: { include: { tag: true } },
        collectionItems: { include: { collection: true } },
        attachments: { include: { revisions: true } },
        notesList: { where: { deletedAt: null } },
      },
    });
  }

  async findMatchCandidates(
    scope: { userId?: string; projectId?: string | null } | string,
    criteria: {
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      titleWords?: string[];
      titlePrefix?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<{
    exactMatch?: {
      id: string;
      title: string;
      matchReason: 'DOI_EXACT' | 'ARXIV_EXACT' | 'PMID_EXACT' | 'ISBN_EXACT';
      evidence: Record<string, any>;
    } | null;
    candidateItems: Array<{
      id: string;
      title: string;
      doi: string | null;
      year: number | null;
      citationKey: string | null;
      authors: string[];
    }>;
  }> {
    let scopeWhere: Prisma.ItemWhereInput | null = null;
    if (typeof scope === 'object' && scope !== null) {
      if (scope.projectId && isUuid(scope.projectId)) {
        scopeWhere = { projectId: scope.projectId, deletedAt: null };
      } else if (scope.userId && isUuid(scope.userId)) {
        scopeWhere = { userId: scope.userId, projectId: null, deletedAt: null };
      }
    } else if (typeof scope === 'string' && isUuid(scope)) {
      scopeWhere = {
        deletedAt: null,
        OR: [{ projectId: scope }, { userId: scope }],
      };
    }

    if (!scopeWhere) {
      return { exactMatch: null, candidateItems: [] };
    }

    const client = this.getClient(tx);

    // 1. Exact DOI match
    if (criteria.doi?.trim()) {
      const cleanDoi = criteria.doi.trim().toLowerCase();
      const match = await client.item.findFirst({
        where: {
          ...scopeWhere,
          doi: { equals: cleanDoi, mode: 'insensitive' },
        },
        select: { id: true, title: true, doi: true },
      });
      if (match) {
        return {
          exactMatch: {
            id: match.id,
            title: match.title,
            matchReason: 'DOI_EXACT',
            evidence: { doi: cleanDoi },
          },
          candidateItems: [],
        };
      }
    }

    // 2. Exact arXiv ID match
    if (criteria.arxivId?.trim()) {
      const cleanArxiv = criteria.arxivId.trim();
      const baseArxiv = cleanArxiv.replace(/v\d+$/i, '');
      const match = await client.item.findFirst({
        where: {
          ...scopeWhere,
          OR: [
            { metadata: { path: ['arxivId'], equals: cleanArxiv } },
            { metadata: { path: ['arxivId'], equals: baseArxiv } },
          ],
        },
        select: { id: true, title: true },
      });
      if (match) {
        return {
          exactMatch: {
            id: match.id,
            title: match.title,
            matchReason: 'ARXIV_EXACT',
            evidence: { arxivId: cleanArxiv },
          },
          candidateItems: [],
        };
      }
    }

    // 3. Exact PMID match
    if (criteria.pmid?.trim()) {
      const cleanPmid = criteria.pmid.trim();
      const match = await client.item.findFirst({
        where: {
          ...scopeWhere,
          metadata: { path: ['pmid'], equals: cleanPmid },
        },
        select: { id: true, title: true },
      });
      if (match) {
        return {
          exactMatch: {
            id: match.id,
            title: match.title,
            matchReason: 'PMID_EXACT',
            evidence: { pmid: cleanPmid },
          },
          candidateItems: [],
        };
      }
    }

    // 4. Exact ISBN match
    if (criteria.isbn?.trim()) {
      const cleanIsbn = criteria.isbn.replace(/[-\s]/g, '').trim();
      const match = await client.item.findFirst({
        where: {
          ...scopeWhere,
          metadata: { path: ['isbn'], equals: cleanIsbn },
        },
        select: { id: true, title: true },
      });
      if (match) {
        return {
          exactMatch: {
            id: match.id,
            title: match.title,
            matchReason: 'ISBN_EXACT',
            evidence: { isbn: cleanIsbn },
          },
          candidateItems: [],
        };
      }
    }

    // 5. Title candidate filter
    const words = (criteria.titleWords || [])
      .filter((w) => w.length >= 3)
      .slice(0, 3);
    let titleCondition: Prisma.ItemWhereInput | null = null;
    if (words.length > 0) {
      titleCondition = {
        OR: words.map((w) => ({ title: { contains: w, mode: 'insensitive' } })),
      };
    } else if (criteria.titlePrefix && criteria.titlePrefix.length > 3) {
      titleCondition = {
        title: {
          contains: criteria.titlePrefix.substring(0, 10),
          mode: 'insensitive',
        },
      };
    }

    if (!titleCondition) {
      return { exactMatch: null, candidateItems: [] };
    }

    const items = await client.item.findMany({
      where: {
        ...scopeWhere,
        ...titleCondition,
      },
      select: {
        id: true,
        title: true,
        doi: true,
        year: true,
        citationKey: true,
        contributors: {
          select: { fullName: true },
          orderBy: { orderIndex: 'asc' },
        },
      },
      take: 200,
    });

    return {
      exactMatch: null,
      candidateItems: items.map((it: any) => ({
        id: it.id,
        title: it.title,
        doi: it.doi,
        year: it.year,
        citationKey: it.citationKey,
        authors: it.contributors.map((c: any) => c.fullName),
      })),
    };
  }
}
