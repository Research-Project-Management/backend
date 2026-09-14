import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ItemsService } from '../items/items.service';
import { PrismaService } from '../../../core/database/prisma.service';

export interface LibraryItemSummary {
  id: string;
  title: string;
  doi?: string | null;
  abstract?: string | null;
  year?: number | null;
  itemType: string;
  authors: string[];
}

export interface ILibraryFacade {
  getItem(
    projectId: string,
    itemId: string,
  ): Promise<LibraryItemSummary | null>;
  countItems(projectId: string): Promise<number>;
  searchItems(projectId: string, query: string): Promise<LibraryItemSummary[]>;
}

export const LIBRARY_FACADE = 'LIBRARY_FACADE';

@Injectable()
export class LibraryFacade implements ILibraryFacade {
  constructor(
    private readonly itemsService: ItemsService,
    private readonly prisma: PrismaService,
  ) {}

  private buildScopeFilter(scopeId: string): Prisma.ItemWhereInput {
    return {
      OR: [{ projectId: scopeId }, { userId: scopeId }],
    };
  }

  async getItem(
    projectId: string,
    itemId: string,
  ): Promise<LibraryItemSummary | null> {
    const item = await this.prisma.item.findFirst({
      where: {
        id: itemId,
        ...this.buildScopeFilter(projectId),
        deletedAt: null,
      },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
      },
    });

    if (!item) return null;

    return {
      id: item.id,
      title: item.title,
      doi: item.doi,
      abstract: item.abstract,
      year: item.year,
      itemType: item.itemType || 'journalArticle',
      authors: (item.contributors || [])
        .map((c: any) => c.fullName || '')
        .filter(Boolean),
    };
  }

  async countItems(projectId: string): Promise<number> {
    return this.prisma.item.count({
      where: {
        ...this.buildScopeFilter(projectId),
        deletedAt: null,
      },
    });
  }

  async searchItems(
    projectId: string,
    query: string,
  ): Promise<LibraryItemSummary[]> {
    const items = await this.prisma.item.findMany({
      where: {
        ...this.buildScopeFilter(projectId),
        deletedAt: null,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { abstract: { contains: query, mode: 'insensitive' } },
        ],
      },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
      },
      take: 20,
    });

    return items.map((item) => ({
      id: item.id,
      title: item.title,
      doi: item.doi,
      abstract: item.abstract,
      year: item.year,
      itemType: item.itemType || 'journalArticle',
      authors: (item.contributors || [])
        .map((c: any) => c.fullName || '')
        .filter(Boolean),
    }));
  }
}
