import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma } from '@prisma/client';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export type PageWithAuthor = Prisma.PageGetPayload<{
  include: {
    author: {
      select: typeof USER_SELECT;
    };
  };
}>;

@Injectable()
export class PageRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findWorkspacePages(workspaceId: string) {
    return this.prisma.page.findMany({
      where: {
        workspaceId,
        parentPageId: null,
        deletedAt: null,
      },
      include: {
        author: { select: USER_SELECT },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findProjectPages(projectId: string) {
    return this.prisma.page.findMany({
      where: {
        projectId,
        parentPageId: null,
        deletedAt: null,
      },
      include: {
        author: { select: USER_SELECT },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findPageById(pageId: string) {
    return this.prisma.page.findUnique({
      where: { id: pageId },
      include: {
        author: { select: USER_SELECT },
        childPages: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  async findPageWithVersions(pageId: string) {
    return this.prisma.page.findUnique({
      where: { id: pageId },
      include: {
        versions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
  }

  async findChildPages(parentPageId: string) {
    return this.prisma.page.findMany({
      where: {
        parentPageId,
        deletedAt: null,
      },
      include: {
        author: { select: USER_SELECT },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createPage(
    data: Prisma.PageCreateInput | Prisma.PageUncheckedCreateInput,
  ): Promise<PageWithAuthor> {
    return this.prisma.page.create({
      data: data as Prisma.PageCreateInput,
      include: {
        author: { select: USER_SELECT },
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
        author: { select: USER_SELECT },
      },
    });
  }

  async deletePage(pageId: string) {
    return this.prisma.page.update({
      where: { id: pageId },
      data: { deletedAt: new Date() },
    });
  }

  async incrementPageView(pageId: string) {
    return this.prisma.page.update({
      where: { id: pageId },
      data: {
        views: { increment: 1 },
        lastAccessedAt: new Date(),
      },
    });
  }

  async findProjectWorkspaceId(projectId: string): Promise<string | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    return project?.workspaceId || null;
  }
}
