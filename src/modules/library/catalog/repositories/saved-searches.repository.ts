import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma } from '@prisma/client';
import {
  normalizeProjectSpaceId,
  resolveSpaceId,
  VersionMismatchException,
  collectDescendantCollectionIds,
} from '@/modules/library/core';
import {
  ExecuteSavedSearchOptions,
  type CreateSavedSearchInput,
  type UpdateSavedSearchInput,
} from '@/modules/library/catalog/types/catalog.types';

@Injectable()
export class SavedSearchesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findCollectionDescendantsMap(
    userId: string,
    projectId: string | undefined,
    rootCollectionIds: string[],
  ): Promise<Map<string, string[]>> {
    const descendantMap = new Map<string, string[]>();
    if (!rootCollectionIds.length || !this.prisma?.libraryCollection?.findMany)
      return descendantMap;
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
        const descendants = collectDescendantCollectionIds(
          allCollections,
          colId,
        );
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
    return normalizeProjectSpaceId(projectId);
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
      this.normalizeProjectId(
        projectId || (dto as { spaceId?: string }).spaceId || dto.projectId,
      ) || null;
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

  async countMatchingItems(
    where: Prisma.LibraryItemWhereInput,
  ): Promise<number> {
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
