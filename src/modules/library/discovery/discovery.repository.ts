import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma, SavedSearch } from '@prisma/client';

export interface DiscoverySearchOptions {
  q?: string;
  itemType?: string;
  collectionId?: string;
  tagId?: string;
  yearFrom?: number;
  yearTo?: number;
  sortBy?: 'relevance' | 'dateAdded' | 'year' | 'title';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
}

export interface FacetResult {
  itemTypes: Record<string, number>;
  years: Record<number, number>;
  tags: Record<string, number>;
}

@Injectable()
export class DiscoveryRepository {
  private readonly logger = new Logger(DiscoveryRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx || this.prisma;
  }

  async searchItems(
    workspaceId: string,
    options: DiscoverySearchOptions,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const limit = Math.min(options.limit ?? 20, 100);

    const where: Prisma.CatalogItemWhereInput = {
      workspaceId,
      deletedAt: null,
      ...(options.itemType ? { itemType: options.itemType } : {}),
      ...(options.yearFrom || options.yearTo
        ? {
            year: {
              ...(options.yearFrom ? { gte: options.yearFrom } : {}),
              ...(options.yearTo ? { lte: options.yearTo } : {}),
            },
          }
        : {}),
      ...(options.collectionId
        ? {
            collectionItems: {
              some: {
                collectionId: options.collectionId,
              },
            },
          }
        : {}),
      ...(options.tagId
        ? {
            itemTags: {
              some: {
                tagId: options.tagId,
              },
            },
          }
        : {}),
      ...(options.q && options.q.trim()
        ? {
            OR: [
              { title: { contains: options.q.trim(), mode: 'insensitive' } },
              { abstract: { contains: options.q.trim(), mode: 'insensitive' } },
              { doi: { contains: options.q.trim(), mode: 'insensitive' } },
              {
                citationKey: {
                  contains: options.q.trim(),
                  mode: 'insensitive',
                },
              },
              {
                publicationTitle: {
                  contains: options.q.trim(),
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.CatalogItemOrderByWithRelationInput =
      options.sortBy === 'year'
        ? { year: options.sortOrder || 'desc' }
        : options.sortBy === 'title'
          ? { title: options.sortOrder || 'asc' }
          : { createdAt: options.sortOrder || 'desc' };

    const items = await client.catalogItem.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: {
        attachments: {
          take: 5,
        },
        itemTags: {
          include: { tag: true },
        },
        collectionItems: {
          include: { collection: true },
        },
      },
    });

    let hasNextPage = false;
    let nextCursor: string | undefined;

    if (items.length > limit) {
      hasNextPage = true;
      const popped = items.pop();
      nextCursor = popped?.id;
    }

    return {
      items,
      nextCursor,
      hasNextPage,
    };
  }

  async computeFacets(
    workspaceId: string,
    options: DiscoverySearchOptions,
    tx?: Prisma.TransactionClient,
  ): Promise<FacetResult> {
    const client = this.getClient(tx);

    const items = await client.catalogItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
      },
      select: {
        itemType: true,
        year: true,
        itemTags: {
          select: {
            tag: {
              select: { name: true },
            },
          },
        },
      },
    });

    const itemTypes: Record<string, number> = {};
    const years: Record<number, number> = {};
    const tags: Record<string, number> = {};

    for (const item of items) {
      if (item.itemType) {
        itemTypes[item.itemType] = (itemTypes[item.itemType] || 0) + 1;
      }
      if (item.year) {
        years[item.year] = (years[item.year] || 0) + 1;
      }
      for (const t of item.itemTags) {
        if (t.tag?.name) {
          tags[t.tag.name] = (tags[t.tag.name] || 0) + 1;
        }
      }
    }

    return { itemTypes, years, tags };
  }

  async createSavedSearch(
    workspaceId: string,
    userId: string,
    data: {
      name: string;
      query: Record<string, any>;
      color?: string;
      icon?: string;
    },
  ): Promise<SavedSearch> {
    return this.prisma.savedSearch.create({
      data: {
        workspaceId,
        userId,
        name: data.name,
        query: data.query,
        color: data.color ?? '#3370ff',
        icon: data.icon ?? 'search',
      },
    });
  }

  async listSavedSearches(
    workspaceId: string,
    userId: string,
  ): Promise<SavedSearch[]> {
    return this.prisma.savedSearch.findMany({
      where: { workspaceId, userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteSavedSearch(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<boolean> {
    const deleted = await this.prisma.savedSearch.deleteMany({
      where: { id, workspaceId, userId },
    });
    return deleted.count > 0;
  }
}
