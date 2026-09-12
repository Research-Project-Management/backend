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

  private buildScopeFilter(scopeId: string) {
    return {
      OR: [{ projectId: scopeId }, { userId: scopeId }],
    };
  }

  async getLibraryStats(scopeId: string): Promise<LibraryStats> {
    const scopeFilter = this.buildScopeFilter(scopeId);
    const [itemsCount, collectionsCount, tagsCount, notesCount, attachments] =
      await Promise.all([
        this.prisma.item.count({
          where: { ...scopeFilter, deletedAt: null },
        }),
        this.prisma.collection.count({
          where: { ...scopeFilter, deletedAt: null },
        }),
        this.prisma.tag.count({
          where: scopeFilter,
        }),
        this.prisma.note.count({
          where: {
            OR: [{ projectId: scopeId }, { userId: scopeId }],
            deletedAt: null,
          },
        }),
        this.prisma.attachment.aggregate({
          _count: { id: true },
          _sum: { size: true },
          where: {
            item: {
              ...scopeFilter,
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
      storageBytes: Number(attachments._sum.size || 0),
    };
  }

  async getLibraryOverview(
    scopeId: string,
    userId?: string,
  ): Promise<LibraryOverview> {
    const scopeFilter = this.buildScopeFilter(scopeId);
    const [recentItems, unfiledCount, trashCount, starredCount, tags] =
      await Promise.all([
        this.prisma.item.findMany({
          where: { ...scopeFilter, deletedAt: null },
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
            ...scopeFilter,
            deletedAt: null,
            collectionItems: { none: {} },
          },
        }),
        this.prisma.item.count({
          where: {
            ...scopeFilter,
            deletedAt: { not: null },
          },
        }),
        this.prisma.item.count({
          where: {
            ...scopeFilter,
            deletedAt: null,
            states: {
              some: userId
                ? { userId, rating: { gt: 0 } }
                : { rating: { gt: 0 } },
            },
          },
        }),
        this.prisma.tag.findMany({
          where: scopeFilter,
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

  async getUserOverview(userId: string): Promise<LibraryOverview> {
    const prismaAny = this.prisma as any;
    try {
      const member = prismaAny.projectMember?.findFirst
        ? await prismaAny.projectMember.findFirst({
            where: { userId },
            select: { projectId: true },
          })
        : null;
      if (member?.projectId) {
        return this.getLibraryOverview(member.projectId, userId);
      }
    } catch {
      // ignore
    }
    return this.getLibraryOverview(userId, userId);
  }

  async countItems(scopeId: string): Promise<number> {
    const scopeFilter = this.buildScopeFilter(scopeId);
    return this.prisma.item.count({
      where: { ...scopeFilter, deletedAt: null },
    });
  }

  async searchItems(
    scopeId: string,
    query: string,
  ): Promise<LibraryItemSummary[]> {
    const scopeFilter = this.buildScopeFilter(scopeId);
    const items = await this.prisma.item.findMany({
      where: {
        ...scopeFilter,
        deletedAt: null,
        ...(query
          ? {
              OR: [
                { title: { contains: query, mode: 'insensitive' } },
                { abstract: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
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
        .map((c: { fullName: string }) => c.fullName || '')
        .filter(Boolean),
    }));
  }
}
