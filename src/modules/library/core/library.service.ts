import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  LibraryStats,
  LibraryOverview,
  LibraryItemSummary,
} from './types/library.types';

@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getLibraryStats(workspaceId: string): Promise<LibraryStats> {
    const [itemsCount, collectionsCount, tagsCount, notesCount, attachments] =
      await Promise.all([
        this.prisma.item.count({
          where: { workspaceId, deletedAt: null },
        }),
        this.prisma.collection.count({
          where: { workspaceId, deletedAt: null },
        }),
        this.prisma.tag.count({
          where: { workspaceId },
        }),
        this.prisma.note.count({
          where: { workspaceId, deletedAt: null },
        }),
        this.prisma.attachment.aggregate({
          _count: { id: true },
          _sum: { size: true },
          where: {
            item: {
              workspaceId,
              deletedAt: null,
            },
          },
        }),
      ]);

    return {
      itemsCount,
      collectionsCount,
      tagsCount,
      notesCount,
      attachmentsCount: attachments._count.id || 0,
      storageBytes: attachments._sum.size || 0,
    };
  }

  async getLibraryOverview(
    workspaceId: string,
    userId?: string,
  ): Promise<LibraryOverview> {
    const [recentItems, unfiledCount, trashCount, starredCount, tags] =
      await Promise.all([
        this.prisma.item.findMany({
          where: { workspaceId, deletedAt: null },
          orderBy: { updatedAt: 'desc' },
          take: 10,
          include: {
            contributors: {
              orderBy: { orderIndex: 'asc' },
            },
          },
        }),
        this.prisma.item.count({
          where: {
            workspaceId,
            deletedAt: null,
            collectionItems: { none: {} },
          },
        }),
        this.prisma.item.count({
          where: {
            workspaceId,
            deletedAt: { not: null },
          },
        }),
        this.prisma.item.count({
          where: {
            workspaceId,
            deletedAt: null,
            states: {
              some: userId
                ? { userId, rating: { gt: 0 } }
                : { rating: { gt: 0 } },
            },
          },
        }),
        this.prisma.tag.findMany({
          where: { workspaceId },
          include: {
            _count: {
              select: { itemTags: true },
            },
          },
          take: 50,
        }),
      ]);

    const topTags = tags
      .map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        count: t._count.itemTags,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      recentItems,
      unfiledCount,
      trashCount,
      starredCount,
      topTags,
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

export const CoreService = LibraryService;
export type CoreService = LibraryService;
