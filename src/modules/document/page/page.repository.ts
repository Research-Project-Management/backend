import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, Page } from '@prisma/client';
import {
  IPageRepository,
  PageWithAuthor,
  PageWithDetails,
  USER_MINIMAL_SELECT,
} from '../types/document-repository.interface';

@Injectable()
export class PageRepository implements IPageRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prisma.workspace.findFirst({
      where: {
        OR: [
          { id: workspaceIdOrSlug },
          { slug: workspaceIdOrSlug },
          { url: workspaceIdOrSlug },
        ],
        deletedAt: null,
      },
      select: { id: true },
    });
  }

  async findWorkspacePages(workspaceId: string): Promise<PageWithAuthor[]> {
    const ws = await this.resolveWorkspace(workspaceId);
    const targetId = ws?.id || workspaceId;
    return this.prisma.page.findMany({
      where: {
        workspaceId: targetId,
        parentPageId: null,
        deletedAt: null,
      },
      include: {
        author: { select: USER_MINIMAL_SELECT },
      },
      orderBy: [{ rank: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async findProjectPages(projectId: string): Promise<PageWithAuthor[]> {
    return this.prisma.page.findMany({
      where: {
        projectId,
        parentPageId: null,
        deletedAt: null,
      },
      include: {
        author: { select: USER_MINIMAL_SELECT },
      },
      orderBy: [{ rank: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async findProjectPageTree(projectId: string): Promise<PageWithAuthor[]> {
    return this.prisma.page.findMany({
      where: {
        projectId,
        deletedAt: null,
      },
      include: {
        author: { select: USER_MINIMAL_SELECT },
      },
      orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findPageById(pageId: string): Promise<PageWithDetails | null> {
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

  async findChildPages(parentPageId: string): Promise<PageWithAuthor[]> {
    return this.prisma.page.findMany({
      where: {
        parentPageId,
        deletedAt: null,
      },
      include: {
        author: { select: USER_MINIMAL_SELECT },
      },
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
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { workspaceId: true },
    });
    return project?.workspaceId || null;
  }
}
