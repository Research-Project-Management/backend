/**
 * Document Domain Repository Interfaces (Ports)
 *
 * Implements Hexagonal / DDD-Lite Architecture decoupling Prisma models from services.
 */

import { Page, PageVersion, PageComment, Prisma } from '@prisma/client';

export const USER_MINIMAL_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export type PageWithAuthor = Prisma.PageGetPayload<{
  include: {
    author: {
      select: typeof USER_MINIMAL_SELECT;
    };
  };
}>;

export type PageWithDetails = Prisma.PageGetPayload<{
  include: {
    author: { select: typeof USER_MINIMAL_SELECT };
    childPages: {
      where: { deletedAt: null };
      orderBy: { rank: 'asc' };
    };
  };
}>;

export interface IPageRepository {
  findWorkspacePages(workspaceId: string): Promise<PageWithAuthor[]>;
  findProjectPages(projectId: string): Promise<PageWithAuthor[]>;
  findProjectPageTree(projectId: string): Promise<PageWithAuthor[]>;
  findPageById(pageId: string): Promise<PageWithDetails | null>;
  findPageBySlug(
    projectId: string,
    slug: string,
  ): Promise<PageWithAuthor | null>;
  findChildPages(parentPageId: string): Promise<PageWithAuthor[]>;
  createPage(
    data: Prisma.PageCreateInput | Prisma.PageUncheckedCreateInput,
  ): Promise<PageWithAuthor>;
  updatePage(
    pageId: string,
    data: Prisma.PageUpdateInput | Prisma.PageUncheckedUpdateInput,
  ): Promise<PageWithAuthor>;
  softDeletePage(pageId: string): Promise<Page>;
  restorePage(pageId: string): Promise<Page>;
  deletePage(pageId: string): Promise<Page>;
  incrementPageView(pageId: string): Promise<Page>;
}

export interface IHistoryRepository {
  findPageVersions(pageId: string): Promise<PageVersion[]>;
  findVersionById(versionId: string): Promise<PageVersion | null>;
  createVersion(
    data:
      Prisma.PageVersionCreateInput | Prisma.PageVersionUncheckedCreateInput,
  ): Promise<PageVersion>;
  deleteVersion(versionId: string): Promise<PageVersion>;
}
