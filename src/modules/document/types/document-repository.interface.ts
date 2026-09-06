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

/** Lean select for list/tree queries — excludes heavy `content` field */
export const PAGE_LIST_SELECT = {
  id: true,
  title: true,
  slug: true,
  icon: true,
  status: true,
  rank: true,
  views: true,
  parentPageId: true,
  mainFileId: true,
  projectId: true,
  workspaceId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  lastAccessedAt: true,
  author: { select: USER_MINIMAL_SELECT },
} as const;

export type PageListItem = Prisma.PageGetPayload<{
  select: typeof PAGE_LIST_SELECT;
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
  findWorkspacePages(workspaceId: string): Promise<PageListItem[]>;
  findProjectPages(projectId: string): Promise<PageListItem[]>;
  findProjectPageTree(projectId: string): Promise<PageListItem[]>;
  findPageById(pageId: string): Promise<PageWithDetails | null>;
  findPageBySlug(
    projectId: string,
    slug: string,
  ): Promise<PageWithAuthor | null>;
  findChildPages(parentPageId: string): Promise<PageListItem[]>;
  findPageAncestorChain(
    startPageId: string,
  ): Promise<Array<{ id: string; parentPageId: string | null }>>;
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

/** Lean version summary — excludes heavy `content` field for history list UI */
export type PageVersionSummary = Prisma.PageVersionGetPayload<{
  select: {
    id: true;
    pageId: true;
    title: true;
    label: true;
    eventType: true;
    savedById: true;
    fileName: true;
    projectPageId: true;
    createdAt: true;
  };
}>;

export interface IHistoryRepository {
  findPageVersions(pageId: string): Promise<PageVersionSummary[]>;
  findVersionById(versionId: string): Promise<PageVersion | null>;
  createVersion(
    data:
      Prisma.PageVersionCreateInput | Prisma.PageVersionUncheckedCreateInput,
  ): Promise<PageVersion>;
  deleteVersion(versionId: string): Promise<PageVersion>;
}
