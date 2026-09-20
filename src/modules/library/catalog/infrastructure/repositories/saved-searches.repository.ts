import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';
import {
  CreateSavedSearchDto,
  UpdateSavedSearchDto,
} from '../../application/dtos/saved-search.dto';
import { ExecuteSavedSearchOptions } from '../../domain/types/saved-search.types';

@Injectable()
export class SavedSearchesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateSavedSearchDto, projectId?: string) {
    const effectiveProjectId = projectId || dto.projectId || null;
    return this.prisma.savedSearch.create({
      data: {
        userId,
        projectId: effectiveProjectId,
        name: dto.name.trim(),
        description: dto.description?.trim() || '',
        icon: dto.icon || '',
        color: dto.color || '#3b82f6',
        conditions: dto.conditions as any,
        conjunction: dto.conjunction || 'AND',
        sortBy: dto.sortBy || 'dateAdded',
        sortOrder: dto.sortOrder || 'desc',
        isPinned: dto.isPinned ?? false,
      },
    });
  }

  async findById(userId: string, id: string, projectId?: string) {
    const where: Prisma.SavedSearchWhereInput = {
      id,
      deletedAt: null,
      ...(projectId ? { projectId } : { userId }),
    };
    return this.prisma.savedSearch.findFirst({
      where,
    });
  }

  async findAll(userId: string, projectId?: string) {
    const where: Prisma.SavedSearchWhereInput = {
      deletedAt: null,
      ...(projectId ? { projectId } : { userId }),
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
  ) {
    const where: Prisma.SavedSearchWhereInput = {
      id,
      deletedAt: null,
      ...(projectId ? { projectId } : { userId }),
    };
    return this.prisma.savedSearch.updateMany({
      where,
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() }
          : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.conditions !== undefined
          ? { conditions: dto.conditions as any }
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
  }

  async updateCachedCount(id: string, cachedCount: number) {
    return this.prisma.savedSearch.update({
      where: { id },
      data: {
        cachedCount,
        lastEvaluatedAt: new Date(),
      },
    });
  }

  async softDelete(userId: string, id: string, projectId?: string) {
    const where: Prisma.SavedSearchWhereInput = {
      id,
      deletedAt: null,
      ...(projectId ? { projectId } : { userId }),
    };
    return this.prisma.savedSearch.updateMany({
      where,
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async countMatchingItems(where: Prisma.ItemWhereInput): Promise<number> {
    return this.prisma.item.count({ where });
  }

  async findMatchingItems(
    where: Prisma.ItemWhereInput,
    options: ExecuteSavedSearchOptions,
  ) {
    const limit = Math.min(options.limit ?? 50, 100);

    const orderBy: Prisma.ItemOrderByWithRelationInput =
      options.sortBy === 'year'
        ? { year: options.sortOrder || 'desc' }
        : options.sortBy === 'title'
          ? { title: options.sortOrder || 'asc' }
          : { createdAt: options.sortOrder || 'desc' };

    const items = await this.prisma.item.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        identifiers: true,
        attachments: { take: 5 },
        itemTags: { include: { tag: true } },
        collectionItems: { include: { collection: true } },
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
