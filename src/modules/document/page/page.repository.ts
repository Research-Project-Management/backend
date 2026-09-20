import { Injectable } from '@nestjs/common';
import { isUUID as isUuid } from 'class-validator';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, Page, PageStatus } from '@prisma/client';
import { resolveCanonicalProjectId } from './utils/page.utils';
import {
  IPageRepository,
  PageWithAuthor,
  PageWithDetails,
  PageListItem,
  PAGE_LIST_SELECT,
  USER_MINIMAL_SELECT,
} from './types/page-repository.interface';

@Injectable()
export class PageRepository implements IPageRepository {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveProjectId(projectId: string): Promise<string | null> {
    return resolveCanonicalProjectId(this.prisma, projectId);
  }

  async findProjectPages(
    projectId: string,
    status?: string,
    search?: string,
  ): Promise<PageListItem[]> {
    const canonicalProjectId = await this.resolveProjectId(projectId);
    if (!canonicalProjectId) return [];

    const where: Prisma.PageWhereInput = {
      projectId: canonicalProjectId,
    };

    if (status === 'archived') {
      where.OR = [
        { status: PageStatus.archived },
        { deletedAt: { not: null } },
      ];
    } else {
      where.deletedAt = null;
      if (status && status !== 'all' && status in PageStatus) {
        where.status = status as PageStatus;
      } else if (!status || status === 'all') {
        where.status = { not: PageStatus.archived };
      }
    }

    if (search && search.trim()) {
      where.title = { contains: search.trim(), mode: 'insensitive' };
    }

    return this.prisma.page.findMany({
      where,
      select: PAGE_LIST_SELECT,
      orderBy: [{ rank: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async findProjectPageTree(projectId: string): Promise<PageListItem[]> {
    const canonicalProjectId = await this.resolveProjectId(projectId);
    if (!canonicalProjectId) return [];

    return this.prisma.page.findMany({
      where: {
        projectId: canonicalProjectId,
        deletedAt: null,
      },
      select: PAGE_LIST_SELECT,
      orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Lean ancestor chain traversal — only fetches `id` and `parentPageId`.
   * Uses single PostgreSQL Recursive CTE to prevent N+1 query amplification.
   */
  async findPageAncestorChain(
    startPageId: string,
  ): Promise<Array<{ id: string; parentPageId: string | null }>> {
    if (!isUuid(startPageId)) return [];

    try {
      if (typeof (this.prisma as any).$queryRaw === 'function') {
        const rows = await this.prisma.$queryRaw<
          Array<{ id: string; parentPageId: string | null }>
        >`
          WITH RECURSIVE ancestors AS (
            SELECT id, parent_page_id AS "parentPageId", 1 AS depth
            FROM pages
            WHERE id = ${startPageId}::uuid AND deleted_at IS NULL
            UNION ALL
            SELECT p.id, p.parent_page_id AS "parentPageId", a.depth + 1
            FROM pages p
            INNER JOIN ancestors a ON p.id = a."parentPageId"
            WHERE p.deleted_at IS NULL AND a.depth < 50
          )
          SELECT id, "parentPageId" FROM ancestors;
        `;
        if (Array.isArray(rows) && rows.length > 0) {
          return rows;
        }
      }
    } catch {
      // Fallback to iterative lookup
    }

    const result: Array<{ id: string; parentPageId: string | null }> = [];
    const visited = new Set<string>();
    let currentId: string | null = startPageId;
    let depth = 0;

    while (currentId && !visited.has(currentId) && depth < 50) {
      visited.add(currentId);
      const row: {
        id: string;
        parentPageId: string | null;
        deletedAt: Date | null;
      } | null = await this.prisma.page.findUnique({
        where: { id: currentId },
        select: { id: true, parentPageId: true, deletedAt: true },
      });
      if (!row || row.deletedAt) break;
      result.push({ id: row.id, parentPageId: row.parentPageId });
      currentId = row.parentPageId;
      depth++;
    }

    return result;
  }

  async findPageById(
    pageId: string,
    includeDeleted = false,
  ): Promise<PageWithDetails | null> {
    if (!isUuid(pageId)) return null;

    const where: Prisma.PageWhereUniqueInput = { id: pageId };
    if (!includeDeleted) {
      const page = await this.prisma.page.findUnique({
        where,
        include: {
          author: { select: USER_MINIMAL_SELECT },
          childPages: {
            where: { deletedAt: null },
            orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
          },
        },
      });
      return page && !page.deletedAt ? page : null;
    }

    return this.prisma.page.findUnique({
      where,
      include: {
        author: { select: USER_MINIMAL_SELECT },
        childPages: {
          orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
  }

  async findPageBySlug(
    projectId: string,
    slug: string,
  ): Promise<PageWithAuthor | null> {
    const canonicalProjectId = await this.resolveProjectId(projectId);
    if (!canonicalProjectId) return null;

    return this.prisma.page.findFirst({
      where: {
        projectId: canonicalProjectId,
        slug,
        deletedAt: null,
      },
      include: {
        author: { select: USER_MINIMAL_SELECT },
      },
    });
  }

  async findPageWithVersions(pageId: string) {
    if (!isUuid(pageId)) return null;
    return this.prisma.page.findFirst({
      where: { id: pageId, deletedAt: null },
      include: {
        versions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
  }

  async findChildPages(parentPageId: string): Promise<PageListItem[]> {
    if (!isUuid(parentPageId)) return [];

    return this.prisma.page.findMany({
      where: {
        parentPageId,
        deletedAt: null,
      },
      select: PAGE_LIST_SELECT,
      orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createPage(
    data: Prisma.PageCreateInput | Prisma.PageUncheckedCreateInput,
  ): Promise<PageWithAuthor> {
    return this.prisma.page.create({
      data: data as Prisma.PageCreateInput,
      include: {
        author: { select: USER_MINIMAL_SELECT },
      },
    });
  }

  async updatePage(
    pageId: string,
    data: Prisma.PageUpdateInput | Prisma.PageUncheckedUpdateInput,
  ): Promise<PageWithAuthor> {
    return this.prisma.page.update({
      where: { id: pageId },
      data: data,
      include: {
        author: { select: USER_MINIMAL_SELECT },
      },
    });
  }

  async softDeletePage(pageId: string): Promise<Page> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.page.updateMany({
        where: { parentPageId: pageId, deletedAt: null },
        data: { deletedAt: now },
      });

      return tx.page.update({
        where: { id: pageId },
        data: { deletedAt: now },
      });
    });
  }

  async restorePage(pageId: string): Promise<Page> {
    return this.prisma.$transaction(async (tx) => {
      await tx.page.updateMany({
        where: { parentPageId: pageId, deletedAt: { not: null } },
        data: { deletedAt: null },
      });

      return tx.page.update({
        where: { id: pageId },
        data: { deletedAt: null },
      });
    });
  }

  async restoreChildPages(parentPageId: string): Promise<number> {
    const res = await this.prisma.page.updateMany({
      where: { parentPageId, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    return res.count;
  }

  async deletePage(pageId: string): Promise<Page> {
    return this.prisma.page.delete({
      where: { id: pageId },
    });
  }

  async incrementPageView(pageId: string): Promise<Page> {
    return this.prisma.page.update({
      where: { id: pageId },
      data: {
        views: { increment: 1 },
        lastAccessedAt: new Date(),
      },
    });
  }

  async findProjectContext(projectId: string): Promise<{ id: string } | null> {
    const canonicalProjectId = await this.resolveProjectId(projectId);
    if (!canonicalProjectId) return null;

    return this.prisma.project.findUnique({
      where: { id: canonicalProjectId },
      select: { id: true },
    });
  }

  async findProjectMember(
    projectId: string,
    userId: string,
  ): Promise<{ role: string } | null> {
    const canonicalProjectId = await this.resolveProjectId(projectId);
    if (!canonicalProjectId) return null;

    return this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId: canonicalProjectId, userId },
      },
      select: { role: true },
    });
  }
}
