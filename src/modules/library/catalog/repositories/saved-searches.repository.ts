import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, ReadStatus } from '@prisma/client';
import { normalizeProjectScopeId, resolveSpaceId, VersionMismatchException, collectDescendantCollectionIds } from '@/modules/library/core';
import {
  ExecuteSavedSearchOptions,
  StateEntity,
  UpsertStateData,
  type CreateSavedSearchInput,
  type UpdateSavedSearchInput,
} from '@/modules/library/catalog/types/catalog.types';
import { pickPreferredMergedState } from '@/modules/library/catalog/domain/state.domain';

@Injectable()
export class SavedSearchesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findCollectionDescendantsMap(
    userId: string,
    projectId: string | undefined,
    rootCollectionIds: string[],
  ): Promise<Map<string, string[]>> {
    const descendantMap = new Map<string, string[]>();
    if (!rootCollectionIds.length || !this.prisma?.libraryCollection?.findMany) return descendantMap;
    const effectiveProjectId = this.normalizeProjectId(projectId);
    const scopeWhere: Prisma.LibraryCollectionWhereInput = {
      spaceId: resolveSpaceId({ userId, projectId: effectiveProjectId }),
      deletedAt: null,
    };
    try {
      const allCollections = await this.prisma.libraryCollection.findMany({
        where: scopeWhere,
        select: { id: true, parentId: true },
      });
      for (const colId of rootCollectionIds) {
        const descendants = collectDescendantCollectionIds(allCollections, colId);
        descendantMap.set(colId, [colId, ...descendants]);
      }
    } catch {
      // Graceful fallback
    }
    return descendantMap;
  }

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  private normalizeProjectId(projectId?: string | null): string | undefined {
    return normalizeProjectScopeId(projectId);
  }

  async create(
    userId: string,
    dto: CreateSavedSearchInput,
    projectId?: string,
    tx?: Prisma.TransactionClient,
    initialCount?: number,
  ) {
    const client = this.getClient(tx);
    const effectiveProjectId =
      this.normalizeProjectId(projectId || dto.projectId) || null;
    const spaceId = resolveSpaceId({ userId, projectId: effectiveProjectId });
    return client.librarySavedSearch.create({
      data: {
        spaceId,
        createdById: userId,
        name: dto.name.trim(),
        description: dto.description?.trim() || '',
        icon: dto.icon || '',
        color: dto.color || '#3b82f6',
        conditions: dto.conditions as unknown as Prisma.InputJsonValue,
        conjunction: dto.conjunction || 'AND',
        sortBy: dto.sortBy || 'dateAdded',
        sortOrder: dto.sortOrder || 'desc',
        isPinned: dto.isPinned ?? false,
        ...(typeof initialCount === 'number'
          ? { cachedCount: initialCount, lastEvaluatedAt: new Date() }
          : {}),
      },
    });
  }

  async findById(
    userId: string,
    id: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const effectiveProjectId = this.normalizeProjectId(projectId);
    const where: Prisma.LibrarySavedSearchWhereInput = {
      id,
      deletedAt: null,
      spaceId: resolveSpaceId({ userId, projectId: effectiveProjectId }),
    };
    return client.librarySavedSearch.findFirst({
      where,
    });
  }

  async findAll(userId: string, projectId?: string) {
    const effectiveProjectId = this.normalizeProjectId(projectId);
    const where: Prisma.LibrarySavedSearchWhereInput = {
      deletedAt: null,
      spaceId: resolveSpaceId({ userId, projectId: effectiveProjectId }),
    };
    return this.prisma.librarySavedSearch.findMany({
      where,
      orderBy: [{ isPinned: 'desc' }, { name: 'asc' }],
    });
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateSavedSearchInput,
    projectId?: string,
    tx?: Prisma.TransactionClient,
    cachedCount?: number,
  ) {
    const client = this.getClient(tx);
    const effectiveProjectId = this.normalizeProjectId(projectId);
    const scopeWhere = {
      spaceId: resolveSpaceId({ userId, projectId: effectiveProjectId }),
    };
    const expectedVersion = dto.expectedVersion ?? dto.version;
    const where: Prisma.LibrarySavedSearchWhereInput = {
      id,
      deletedAt: null,
      ...scopeWhere,
      ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
    };
    const res = await client.librarySavedSearch.updateMany({
      where,
      data: {
        updatedById: userId,
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() }
          : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.conditions !== undefined
          ? {
              conditions: dto.conditions as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(dto.conjunction !== undefined
          ? { conjunction: dto.conjunction }
          : {}),
        ...(dto.sortBy !== undefined ? { sortBy: dto.sortBy } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isPinned !== undefined ? { isPinned: dto.isPinned } : {}),
        ...(typeof cachedCount === 'number'
          ? { cachedCount, lastEvaluatedAt: new Date() }
          : {}),
        version: { increment: 1 },
      },
    });
    if (res.count === 0) {
      const current = await client.librarySavedSearch?.findFirst?.({
        where: { id, deletedAt: null, ...scopeWhere },
      });
      if (!current) {
        throw new NotFoundException(`Saved search ${id} not found`);
      }
      if (expectedVersion !== undefined) {
        throw new VersionMismatchException({
          aggregateType: 'SavedSearch',
          entityId: id,
          currentVersion: current.version ?? 1,
          providedVersion: expectedVersion,
        });
      }
    }
    return res;
  }

  async updateCachedCount(
    id: string,
    cachedCount: number,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.librarySavedSearch.update({
      where: { id },
      data: {
        cachedCount,
        lastEvaluatedAt: new Date(),
      },
    });
  }

  async softDelete(
    userId: string,
    id: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
    expectedVersion?: number,
  ) {
    const client = this.getClient(tx);
    const effectiveProjectId = this.normalizeProjectId(projectId);
    const scopeWhere = {
      spaceId: resolveSpaceId({ userId, projectId: effectiveProjectId }),
    };
    const where: Prisma.LibrarySavedSearchWhereInput = {
      id,
      deletedAt: null,
      ...scopeWhere,
      ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
    };
    const res = await client.librarySavedSearch.updateMany({
      where,
      data: {
        deletedAt: new Date(),
        deletedById: userId,
        version: { increment: 1 },
      },
    });
    if (res.count === 0 && expectedVersion !== undefined) {
      const current = await client.librarySavedSearch?.findFirst?.({
        where: { id, deletedAt: null, ...scopeWhere },
      });
      if (!current) {
        throw new NotFoundException(`Saved search ${id} not found`);
      }
      throw new VersionMismatchException({
        aggregateType: 'SavedSearch',
        entityId: id,
        currentVersion: current.version ?? 1,
        providedVersion: expectedVersion,
      });
    }
    return res;
  }

  async countMatchingItems(where: Prisma.LibraryItemWhereInput): Promise<number> {
    return this.prisma.libraryItem.count({ where });
  }

  private extractUserIdFromWhere(
    where?: Prisma.LibraryItemWhereInput,
  ): string | undefined {
    if (!where || typeof where !== 'object') return undefined;
    const rawWhere = where as { userId?: string; spaceId?: string };
    if (typeof rawWhere.userId === 'string' && rawWhere.userId.trim()) {
      return rawWhere.userId.trim();
    }
    const statesSome = (
      where.states as { some?: { userId?: string } } | undefined
    )?.some;
    if (typeof statesSome?.userId === 'string' && statesSome.userId.trim()) {
      return statesSome.userId.trim();
    }
    const statesNone = (
      where.states as { none?: { userId?: string } } | undefined
    )?.none;
    if (typeof statesNone?.userId === 'string' && statesNone.userId.trim()) {
      return statesNone.userId.trim();
    }
    const andList = Array.isArray(where.AND)
      ? where.AND
      : where.AND
        ? [where.AND]
        : [];
    for (const clause of andList) {
      const found = this.extractUserIdFromWhere(clause);
      if (found) return found;
    }
    const orList = Array.isArray(where.OR)
      ? where.OR
      : where.OR
        ? [where.OR]
        : [];
    for (const clause of orList) {
      const found = this.extractUserIdFromWhere(clause);
      if (found) return found;
    }
    if (typeof rawWhere.spaceId === 'string' && rawWhere.spaceId.trim()) {
      return rawWhere.spaceId.trim();
    }
    return undefined;
  }

  async findMatchingItems(
    where: Prisma.LibraryItemWhereInput,
    options: ExecuteSavedSearchOptions & { userId?: string } = {},
    userIdParam?: string,
  ) {
    const limit = Math.min(options.limit ?? 50, 1000);
    const effectiveUserId =
      userIdParam || options.userId || this.extractUserIdFromWhere(where);

    const sortDir: Prisma.SortOrder =
      options.sortOrder === 'asc' ? 'asc' : 'desc';
    let orderBy: Prisma.LibraryItemOrderByWithRelationInput[];

    if (options.sortBy === 'year') {
      orderBy = [{ year: { sort: sortDir, nulls: 'last' } }, { id: sortDir }];
    } else if (options.sortBy === 'title') {
      const titleDir: Prisma.SortOrder = options.sortOrder || 'asc';
      orderBy = [{ title: titleDir }, { id: titleDir }];
    } else if (
      options.sortBy === 'creator' ||
      options.sortBy === 'authors' ||
      options.sortBy === 'firstAuthor'
    ) {
      const authorDir: Prisma.SortOrder = options.sortOrder || 'asc';
      orderBy = [
        { firstAuthor: { sort: authorDir, nulls: 'last' } },
        { id: authorDir },
      ];
    } else if (
      options.sortBy === 'publication' ||
      options.sortBy === 'publicationTitle'
    ) {
      const pubDir: Prisma.SortOrder = options.sortOrder || 'asc';
      orderBy = [
        { publicationTitle: { sort: pubDir, nulls: 'last' } },
        { id: pubDir },
      ];
    } else if (options.sortBy === 'citationKey') {
      const keyDir: Prisma.SortOrder = options.sortOrder || 'asc';
      orderBy = [
        { citationKey: { sort: keyDir, nulls: 'last' } },
        { id: keyDir },
      ];
    } else if (
      options.sortBy === 'deletedAt' ||
      options.sortBy === 'dateDeleted'
    ) {
      orderBy = [
        { deletedAt: { sort: sortDir, nulls: 'last' } },
        { id: sortDir },
      ];
    } else if (
      options.sortBy === 'updatedAt' ||
      options.sortBy === 'dateModified'
    ) {
      orderBy = [{ updatedAt: sortDir }, { id: sortDir }];
    } else {
      orderBy = [{ createdAt: sortDir }, { id: sortDir }];
    }

    const page = options.page && options.page > 0 ? options.page : 1;
    const skip = options.cursor ? 1 : page > 1 ? (page - 1) * limit : undefined;

    const items = await this.prisma.libraryItem.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(options.cursor
        ? { cursor: { id: options.cursor }, skip: 1 }
        : page > 1
          ? { skip }
          : {}),
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: { where: { deletedAt: null }, take: 5 },
        itemTags: { include: { tag: true } },
        collectionItems: { include: { collection: true } },
        identifiers: true,
        notesList: { where: { deletedAt: null }, select: { id: true } },
        publications: effectiveUserId
          ? {
              where: { userId: effectiveUserId },
              select: { itemId: true },
              take: 1,
            }
          : false,
        ...(effectiveUserId
          ? { states: { where: { userId: effectiveUserId }, take: 1 } }
          : {}),
      },
    });

    let hasNextPage = false;
    let nextCursor: string | undefined;

    if (items.length > limit) {
      hasNextPage = true;
      items.pop();
      nextCursor = items[items.length - 1]?.id;
    }

    return { items, nextCursor, hasNextPage };
  }
}

const STATE_SELECT = {
  userId: true,
  itemId: true,
  isStarred: true,
  readStatus: true,
  rating: true,
  currentPage: true,
  scrollPosition: true,
  lastOpenedAt: true,
  lastReadAt: true,
  updatedAt: true,
} satisfies Prisma.LibraryItemStateSelect;

@Injectable()
export class StateRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findState(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<StateEntity | null> {
    const client = this.getClient(tx);
    return client.libraryItemState.findUnique({
      where: {
        userId_itemId: {
          userId,
          itemId,
        },
      },
      select: STATE_SELECT,
    });
  }

  async findStatesForItems(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<StateEntity[]> {
    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    return client.libraryItemState.findMany({
      where: {
        userId,
        itemId: { in: itemIds },
        ...(validProjectId
          ? { item: { spaceId: validProjectId, deletedAt: null } }
          : {}),
      },
      select: STATE_SELECT,
    });
  }

  async upsertState(
    userId: string,
    itemId: string,
    data: UpsertStateData,
    tx?: Prisma.TransactionClient,
  ): Promise<StateEntity> {
    const client = this.getClient(tx);
    const dbReadStatus = data.readStatus
      ? (data.readStatus as unknown as ReadStatus)
      : undefined;

    const scrollJson =
      data.scrollPosition !== undefined
        ? data.scrollPosition !== null
          ? (data.scrollPosition as Prisma.InputJsonValue)
          : Prisma.JsonNull
        : undefined;

    const scrollObj =
      data.scrollPosition &&
      typeof data.scrollPosition === 'object' &&
      !Array.isArray(data.scrollPosition)
        ? (data.scrollPosition as Record<string, unknown>)
        : null;
    const resolvedAttachmentId =
      data.attachmentId?.trim() ||
      (typeof scrollObj?.attachmentId === 'string' &&
      scrollObj.attachmentId.trim()
        ? scrollObj.attachmentId.trim()
        : undefined);

    if (
      resolvedAttachmentId &&
      typeof client.attachmentReadingState?.upsert === 'function'
    ) {
      const currentPage =
        data.currentPage ??
        (typeof scrollObj?.page === 'number' ? scrollObj.page : undefined);
      const scrollOffsetX =
        typeof scrollObj?.scrollOffsetX === 'number'
          ? scrollObj.scrollOffsetX
          : typeof scrollObj?.left === 'number'
            ? scrollObj.left
            : undefined;
      const scrollOffsetY =
        typeof scrollObj?.scrollOffsetY === 'number'
          ? scrollObj.scrollOffsetY
          : typeof scrollObj?.top === 'number'
            ? scrollObj.top
            : undefined;
      const zoomScale =
        typeof scrollObj?.zoom === 'number'
          ? scrollObj.zoom
          : typeof scrollObj?.zoomScale === 'number'
            ? scrollObj.zoomScale
            : undefined;
      const rotation =
        typeof scrollObj?.rotation === 'number'
          ? scrollObj.rotation
          : undefined;
      const viewMode =
        typeof scrollObj?.viewMode === 'string'
          ? scrollObj.viewMode
          : typeof scrollObj?.fitMode === 'string'
            ? scrollObj.fitMode
            : undefined;
      const bookmarks = Array.isArray(scrollObj?.bookmarks)
        ? (scrollObj.bookmarks as Prisma.InputJsonValue)
        : undefined;

      const [upsertedState] = await Promise.all([
        client.libraryItemState.upsert({
          where: {
            userId_itemId: {
              userId,
              itemId,
            },
          },
          create: {
            userId,
            itemId,
            isStarred: data.isStarred ?? false,
            readStatus: dbReadStatus,
            rating: data.rating,
            currentPage: data.currentPage ?? 1,
            scrollPosition: scrollJson ?? Prisma.JsonNull,
            ...(resolvedAttachmentId
              ? { lastActiveAttachmentId: resolvedAttachmentId }
              : {}),
            lastOpenedAt: data.lastOpenedAt ?? new Date(),
            lastReadAt: data.lastReadAt,
          },
          update: {
            isStarred: data.isStarred,
            readStatus: dbReadStatus,
            rating: data.rating,
            currentPage: data.currentPage,
            scrollPosition: scrollJson,
            ...(resolvedAttachmentId
              ? { lastActiveAttachmentId: resolvedAttachmentId }
              : {}),
            lastOpenedAt: data.lastOpenedAt,
            lastReadAt: data.lastReadAt,
          },
          select: STATE_SELECT,
        }),
        client.attachmentReadingState.upsert({
          where: {
            userId_attachmentId: {
              userId,
              attachmentId: resolvedAttachmentId,
            },
          },
          create: {
            userId,
            attachmentId: resolvedAttachmentId,
            itemId,
            ...(currentPage !== undefined ? { currentPage } : {}),
            ...(scrollOffsetX !== undefined ? { scrollOffsetX } : {}),
            ...(scrollOffsetY !== undefined ? { scrollOffsetY } : {}),
            ...(zoomScale !== undefined ? { zoomScale } : {}),
            ...(rotation !== undefined ? { rotation } : {}),
            ...(viewMode !== undefined ? { viewMode } : {}),
            ...(bookmarks !== undefined ? { bookmarks } : {}),
          },
          update: {
            ...(currentPage !== undefined ? { currentPage } : {}),
            ...(scrollOffsetX !== undefined ? { scrollOffsetX } : {}),
            ...(scrollOffsetY !== undefined ? { scrollOffsetY } : {}),
            ...(zoomScale !== undefined ? { zoomScale } : {}),
            ...(rotation !== undefined ? { rotation } : {}),
            ...(viewMode !== undefined ? { viewMode } : {}),
            ...(bookmarks !== undefined ? { bookmarks } : {}),
            version: { increment: 1 },
          },
        }),
      ]);
      return upsertedState;
    }

    return client.libraryItemState.upsert({
      where: {
        userId_itemId: {
          userId,
          itemId,
        },
      },
      create: {
        userId,
        itemId,
        isStarred: data.isStarred ?? false,
        readStatus: dbReadStatus,
        rating: data.rating,
        currentPage: data.currentPage ?? 1,
        scrollPosition: scrollJson ?? Prisma.JsonNull,
        ...(resolvedAttachmentId
          ? { lastActiveAttachmentId: resolvedAttachmentId }
          : {}),
        lastOpenedAt: data.lastOpenedAt ?? new Date(),
        lastReadAt: data.lastReadAt,
      },
      update: {
        isStarred: data.isStarred,
        readStatus: dbReadStatus,
        rating: data.rating,
        currentPage: data.currentPage,
        scrollPosition: scrollJson,
        ...(resolvedAttachmentId
          ? { lastActiveAttachmentId: resolvedAttachmentId }
          : {}),
        lastOpenedAt: data.lastOpenedAt,
        lastReadAt: data.lastReadAt,
      },
      select: STATE_SELECT,
    });
  }

  async deleteState(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ count: number }> {
    const client = this.getClient(tx);
    return client.libraryItemState.deleteMany({
      where: {
        userId,
        itemId,
      },
    });
  }

  async transferItemStates(
    sourceItemIds: string[],
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;
    const cleanSourceIds = sourceItemIds.filter((id) => id !== targetItemId);
    if (cleanSourceIds.length === 0) return;

    const client = this.getClient(tx);
    const allUserStates = await client.libraryItemState.findMany({
      where: { itemId: { in: [targetItemId, ...cleanSourceIds] } },
    });

    const userStateByUser = new Map<string, typeof allUserStates>();
    for (const us of allUserStates) {
      const list = userStateByUser.get(us.userId) || [];
      list.push(us);
      userStateByUser.set(us.userId, list);
    }

    const userStateEntries = Array.from(userStateByUser.entries()).sort(
      ([uidA], [uidB]) => (uidA < uidB ? -1 : uidA > uidB ? 1 : 0),
    );
    await Promise.all([
      ...userStateEntries.map(([userId, states]) => {
        const merged = pickPreferredMergedState(states);
        const targetState = states.find((s) => s.itemId === targetItemId) as
          | { lastActiveAttachmentId?: string | null }
          | undefined;
        const bestSource = states.find(
          (s) =>
            s.itemId !== targetItemId &&
            Boolean((s as { lastActiveAttachmentId?: string | null }).lastActiveAttachmentId),
        ) as { lastActiveAttachmentId?: string | null } | undefined;
        const lastActiveAttachmentId =
          targetState?.lastActiveAttachmentId ??
          bestSource?.lastActiveAttachmentId ??
          null;
        const scrollJson =
          merged.latestScroll !== undefined && merged.latestScroll !== null
            ? (merged.latestScroll as Prisma.InputJsonValue)
            : undefined;

        return client.libraryItemState.upsert({
          where: {
            userId_itemId: {
              userId,
              itemId: targetItemId,
            },
          },
          create: {
            userId,
            itemId: targetItemId,
            isStarred: merged.isStarred,
            rating: merged.maxRating,
            readStatus: merged.readStatus as Prisma.LibraryItemStateUncheckedCreateInput['readStatus'],
            currentPage: merged.maxCurrentPage,
            scrollPosition: scrollJson ?? Prisma.JsonNull,
            ...(lastActiveAttachmentId
              ? { lastActiveAttachmentId }
              : {}),
            lastOpenedAt: merged.latestOpenedAt,
            lastReadAt: merged.latestReadAt,
          },
          update: {
            isStarred: merged.isStarred,
            rating: merged.maxRating,
            readStatus: merged.readStatus as Prisma.LibraryItemStateUncheckedUpdateInput['readStatus'],
            currentPage: merged.maxCurrentPage,
            scrollPosition: scrollJson,
            ...(lastActiveAttachmentId !== null
              ? { lastActiveAttachmentId }
              : {}),
            lastOpenedAt: merged.latestOpenedAt ?? undefined,
            lastReadAt: merged.latestReadAt ?? undefined,
          },
        });
      }),
      typeof client.attachmentReadingState?.updateMany === 'function'
        ? client.attachmentReadingState.updateMany({
            where: { itemId: { in: cleanSourceIds } },
            data: { itemId: targetItemId },
          })
        : undefined,
      client.libraryItemState.deleteMany({
        where: { itemId: { in: cleanSourceIds } },
      }),
    ]);
  }
}
