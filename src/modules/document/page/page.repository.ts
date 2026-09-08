import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  buildWorkspaceIdentifierWhere,
  isUuid,
} from '@/core/utils/tenant.util';
import { Prisma, Page } from '@prisma/client';
import {
  IPageRepository,
  PageWithAuthor,
  PageWithDetails,
  PageListItem,
  PAGE_LIST_SELECT,
  USER_MINIMAL_SELECT,
} from '../types/document-repository.interface';

@Injectable()
export class PageRepository implements IPageRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prisma.workspace.findFirst({
      where: buildWorkspaceIdentifierWhere(workspaceIdOrSlug),
      select: { id: true },
    });
  }

  async findWorkspacePages(workspaceId: string): Promise<PageListItem[]> {
    const ws = await this.resolveWorkspace(workspaceId);
    const canonicalWorkspaceId =
      ws?.id || (isUuid(workspaceId) ? workspaceId : null);
    if (!canonicalWorkspaceId) return [];

    return this.prisma.page.findMany({
      where: {
        workspaceId: canonicalWorkspaceId,
        parentPageId: null,
        deletedAt: null,
      },
      select: PAGE_LIST_SELECT,
      orderBy: [{ rank: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async findProjectPages(projectId: string): Promise<PageListItem[]> {
    let canonicalProjectId = projectId;
    if (!isUuid(canonicalProjectId)) {
      const proj = await this.prisma.project
        .findFirst({
          where: {
            identifier: { equals: canonicalProjectId, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true },
        })
        .catch(() => null);
      if (!proj) return [];
      canonicalProjectId = proj.id;
    }

    return this.prisma.page.findMany({
      where: {
        projectId: canonicalProjectId,
        parentPageId: null,
        deletedAt: null,
      },
      select: PAGE_LIST_SELECT,
      orderBy: [{ rank: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async findProjectPageTree(projectId: string): Promise<PageListItem[]> {
    let canonicalProjectId = projectId;
    if (!isUuid(canonicalProjectId)) {
      const proj = await this.prisma.project
        .findFirst({
          where: {
            identifier: { equals: canonicalProjectId, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true },
        })
        .catch(() => null);
      if (!proj) return [];
      canonicalProjectId = proj.id;
    }

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
   * Used by `validateNoCircularParent` to avoid N+1 with heavy content payload.
   */
  async findPageAncestorChain(
    startPageId: string,
  ): Promise<Array<{ id: string; parentPageId: string | null }>> {
    const ancestors: Array<{ id: string; parentPageId: string | null }> = [];
    const visited = new Set<string>();
    let currentId: string | null = startPageId;
    let depth = 0;
    const MAX_DEPTH = 50;

    while (currentId && depth < MAX_DEPTH) {
      if (visited.has(currentId)) {
        break;
      }
      visited.add(currentId);
      depth++;

      const row: { id: string; parentPageId: string | null } | null =
        await this.prisma.page.findFirst({
          where: { id: currentId, deletedAt: null },
          select: { id: true, parentPageId: true },
        });
      if (!row) break;
      ancestors.push(row);
      currentId = row.parentPageId;
    }

    return ancestors;
  }

  async findPageById(pageId: string): Promise<PageWithDetails | null> {
    if (!isUuid(pageId)) return null;
    return this.prisma.page.findFirst({
      where: { id: pageId, deletedAt: null },
      include: {
        author: { select: USER_MINIMAL_SELECT },
        childPages: {
          where: { deletedAt: null },
          orderBy: { rank: 'asc' },
        },
      },
    });
  }

  async findPageBySlug(
    projectId: string,
    slug: string,
  ): Promise<PageWithAuthor | null> {
    return this.prisma.page.findFirst({
      where: { projectId, slug, deletedAt: null },
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
      orderBy: { rank: 'asc' },
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
    return this.prisma.page.update({
      where: { id: pageId },
      data: { deletedAt: new Date() },
    });
  }

  async restorePage(pageId: string): Promise<Page> {
    return this.prisma.page.update({
      where: { id: pageId },
      data: { deletedAt: null },
    });
  }

  async deletePage(pageId: string): Promise<Page> {
    return this.softDeletePage(pageId);
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

  async findProjectWorkspaceId(projectId: string): Promise<string | null> {
    if (!isUuid(projectId)) {
      const project = await this.prisma.project
        .findFirst({
          where: {
            identifier: { equals: projectId, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { workspaceId: true },
        })
        .catch(() => null);
      return project?.workspaceId || null;
    }
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { workspaceId: true },
    });
    return project?.workspaceId || null;
  }

  async findProjectContext(
    projectId: string,
  ): Promise<{ id: string; workspaceId: string } | null> {
    if (!isUuid(projectId)) {
      return this.prisma.project
        .findFirst({
          where: {
            identifier: { equals: projectId, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true, workspaceId: true },
        })
        .catch(() => null);
    }
    return this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, workspaceId: true },
    });
  }

  async findWorkspaceMember(
    workspaceId: string,
    userId: string,
  ): Promise<{ role: string } | null> {
    if (!isUuid(workspaceId) || !isUuid(userId)) return null;
    return this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId },
      select: { role: true },
    });
  }

  async findProjectMember(
    projectId: string,
    userId: string,
  ): Promise<{ role: string } | null> {
    if (!isUuid(projectId) || !isUuid(userId)) return null;
    return this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
  }
}
