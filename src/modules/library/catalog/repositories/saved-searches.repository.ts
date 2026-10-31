import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma } from '@prisma/client';
import {
  normalizeProjectScopeId,
  VersionMismatchException,
} from '@/modules/library/core';
import {
  CreateSavedSearchDto,
  UpdateSavedSearchDto,
} from '@/modules/library/catalog/dto/saved-search.dto';
import { ExecuteSavedSearchOptions } from '@/modules/library/catalog/types/saved-search.types';

@Injectable()
export class SavedSearchesRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  private normalizeProjectId(projectId?: string | null): string | undefined {
    return normalizeProjectScopeId(projectId);
  }

  async create(
    userId: string,
    dto: CreateSavedSearchDto,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const effectiveProjectId =
      this.normalizeProjectId(projectId || dto.projectId) || null;
    return client.savedSearch.create({
      data: {
        userId,
        projectId: effectiveProjectId,
        name: dto.name.trim(),
        description: dto.description?.trim() || '',
        icon: dto.icon || '',
        color: dto.color || '#3b82f6',
        conditions: dto.conditions as unknown as Prisma.InputJsonValue,
        conjunction: dto.conjunction || 'AND',
        sortBy: dto.sortBy || 'dateAdded',
        sortOrder: dto.sortOrder || 'desc',
        isPinned: dto.isPinned ?? false,
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
    const scopeWhere = effectiveProjectId
      ? { projectId: effectiveProjectId }
      : { userId, projectId: null };
    const where: Prisma.SavedSearchWhereInput = {
      id,
      deletedAt: null,
      ...scopeWhere,
    };
    return client.savedSearch.findFirst({
      where,
    });
  }

  async findAll(userId: string, projectId?: string) {
    const effectiveProjectId = this.normalizeProjectId(projectId);
    const scopeWhere = effectiveProjectId
      ? { projectId: effectiveProjectId }
      : { userId, projectId: null };
    const where: Prisma.SavedSearchWhereInput = {
      deletedAt: null,
      ...scopeWhere,
    };
    return this.prisma.savedSearch.findMany({
      where,
      orderBy: [{ isPinned: 'desc' }, { name: 'asc' }],
    });
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateSavedSearchDto,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const effectiveProjectId = this.normalizeProjectId(projectId);
    const scopeWhere = effectiveProjectId
      ? { projectId: effectiveProjectId }
      : { userId, projectId: null };
    const expectedVersion = dto.expectedVersion ?? dto.version;
    const where: Prisma.SavedSearchWhereInput = {
      id,
      deletedAt: null,
      ...scopeWhere,
      ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
    };
    const res = await client.savedSearch.updateMany({
      where,
      data: {
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
        version: { increment: 1 },
      },
    });
    if (res.count === 0) {
      const current = await client.savedSearch?.findFirst?.({
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
    return client.savedSearch.update({
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
    const scopeWhere = effectiveProjectId
      ? { projectId: effectiveProjectId }
      : { userId, projectId: null };
    const where: Prisma.SavedSearchWhereInput = {
      id,
      deletedAt: null,
      ...scopeWhere,
      ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
    };
    const res = await client.savedSearch.updateMany({
      where,
      data: {
        deletedAt: new Date(),
        ...(expectedVersion !== undefined ? { version: { increment: 1 } } : {}),
      },
    });
    if (res.count === 0 && expectedVersion !== undefined) {
      const current = await client.savedSearch?.findFirst?.({
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

  async countMatchingItems(where: Prisma.ItemWhereInput): Promise<number> {
    return this.prisma.item.count({ where });
  }

  private extractUserIdFromWhere(
    where?: Prisma.ItemWhereInput,
  ): string | undefined {
    if (!where || typeof where !== 'object') return undefined;
    if (typeof where.userId === 'string' && where.userId.trim()) {
      return where.userId.trim();
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
    return undefined;
  }

  async findMatchingItems(
    where: Prisma.ItemWhereInput,
    options: ExecuteSavedSearchOptions & { userId?: string } = {},
    userIdParam?: string,
  ) {
    const limit = Math.min(options.limit ?? 50, 1000);
    const effectiveUserId =
      userIdParam || options.userId || this.extractUserIdFromWhere(where);

    const sortDir = options.sortOrder || 'desc';
    let orderBy: Prisma.ItemOrderByWithRelationInput[];

    if (options.sortBy === 'year') {
      orderBy = [{ year: sortDir }, { id: 'desc' }];
    } else if (options.sortBy === 'title') {
      orderBy = [{ title: options.sortOrder || 'asc' }, { id: 'desc' }];
    } else if (options.sortBy === 'creator' || options.sortBy === 'authors') {
      orderBy = [{ firstAuthor: options.sortOrder || 'asc' }, { id: 'desc' }];
    } else if (options.sortBy === 'updatedAt') {
      orderBy = [{ updatedAt: sortDir }, { id: 'desc' }];
    } else {
      orderBy = [{ createdAt: sortDir }, { id: 'desc' }];
    }

    const page = options.page && options.page > 0 ? options.page : 1;
    const skip = options.cursor ? 1 : page > 1 ? (page - 1) * limit : undefined;

    const items = await this.prisma.item.findMany({
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

  async executeConditions(
    where: Prisma.ItemWhereInput,
    options: ExecuteSavedSearchOptions & { userId?: string } = {},
    userIdParam?: string,
  ) {
    return this.findMatchingItems(where, options, userIdParam);
  }
}
