import { Injectable, Optional } from '@nestjs/common';
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
    workspaceId: string,
    itemId: string,
  ): Promise<LibraryItemSummary | null>;
  countItems(workspaceId: string): Promise<number>;
  searchItems(
    workspaceId: string,
    query: string,
  ): Promise<LibraryItemSummary[]>;
}

export const LIBRARY_FACADE = 'LIBRARY_FACADE';

@Injectable()
export class LibraryFacade implements ILibraryFacade {
  constructor(
    private readonly itemsService: ItemsService,
    private readonly prisma: PrismaService,
  ) {}

  async getItem(
    workspaceId: string,
    itemId: string,
  ): Promise<LibraryItemSummary | null> {
    const item = await this.prisma.item.findFirst({
      where: { id: itemId, workspaceId, deletedAt: null },
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
      authors: item.contributors.map((c) => c.fullName || '').filter(Boolean),
    };
  }

  async countItems(workspaceId: string): Promise<number> {
    return this.prisma.item.count({
      where: { workspaceId, deletedAt: null },
    });
  }

  async searchItems(
    workspaceId: string,
    query: string,
  ): Promise<LibraryItemSummary[]> {
    const items = await this.prisma.item.findMany({
      where: {
        workspaceId,
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
      authors: item.contributors.map((c) => c.fullName || '').filter(Boolean),
    }));
  }
}
