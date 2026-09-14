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

  private buildScopeFilter(scopeId: string, userId?: string) {
    const isProject =
      Boolean(scopeId) && scopeId !== 'user' && scopeId !== userId;
    if (isProject) {
      return { projectId: scopeId };
    }
    const effectiveUserId = userId || scopeId;
    return { userId: effectiveUserId, projectId: null };
  }

  async getLibraryStats(
    scopeId: string,
    userId?: string,
  ): Promise<LibraryStats> {
    const scopeFilter = this.buildScopeFilter(scopeId, userId);
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
            ...scopeFilter,
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
    const isProject =
      Boolean(scopeId) && scopeId !== 'user' && scopeId !== userId;
    const scopeFilter = this.buildScopeFilter(scopeId, userId);
    const [
      recentItems,
      unfiledCount,
      trashCount,
      starredCount,
      myPublicationsCount,
      candidateItems,
      tags,
    ] = await Promise.all([
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
      this.prisma.item.count({
        where: {
          ...scopeFilter,
          deletedAt: null,
          isMyPublication: true,
        },
      }),
      this.prisma.item.findMany({
        where: { ...scopeFilter, deletedAt: null },
        select: { id: true, title: true, doi: true, year: true },
        take: 2000,
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

    // Fast server-side duplicate detection
    const doiMap = new Map<string, string[]>();
    const titleMap = new Map<string, string[]>();
    const duplicateItemIds = new Set<string>();

    for (const item of candidateItems) {
      if (item.doi) {
        const cleanDoi = item.doi.toLowerCase().trim();
        const list = doiMap.get(cleanDoi) || [];
        list.push(item.id);
        doiMap.set(cleanDoi, list);
      }
      if (item.title) {
        const cleanTitle = item.title
          .toLowerCase()
          .trim()
          .replace(/[^\w\s]/g, '');
        const key = `${cleanTitle}:${item.year || ''}`;
        const list = titleMap.get(key) || [];
        list.push(item.id);
        titleMap.set(key, list);
      }
    }

    doiMap.forEach((ids) => {
      if (ids.length > 1) {
        ids.forEach((id) => duplicateItemIds.add(id));
      }
    });
    titleMap.forEach((ids) => {
      if (ids.length > 1) {
        ids.forEach((id) => duplicateItemIds.add(id));
      }
    });

    const duplicateCount = duplicateItemIds.size;

    // Resolve RBAC permissions
    let permissions = {
      canCreate: true,
      canEdit: true,
      canDelete: true,
      canManageCollections: true,
    };

    if (isProject && userId) {
      const member = await this.prisma.projectMember.findUnique({
        where: {
          projectId_userId: {
            projectId: scopeId,
            userId,
          },
        },
        select: { role: true },
      });

      if (!member) {
        permissions = {
          canCreate: false,
          canEdit: false,
          canDelete: false,
          canManageCollections: false,
        };
      } else if (
        member.role === 'viewer' ||
        (member.role as string) === 'commenter'
      ) {
        permissions = {
          canCreate: false,
          canEdit: false,
          canDelete: false,
          canManageCollections: false,
        };
      }
    }

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
      duplicateCount,
      myPublicationsCount,
      permissions,
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
