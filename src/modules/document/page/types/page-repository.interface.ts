/**
 * Page Domain Repository Interfaces (Ports)
 *
 * Implements clean repository boundaries decoupling Prisma models from services.
 */

import {
  Page,
  PageVersion,
  PageComment,
  Prisma,
  VersionEventType,
} from '@prisma/client';

export const USER_MINIMAL_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
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
  labelAssignments: {
    select: {
      label: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
  },
  views: true,
  parentPageId: true,
  mainFileId: true,
  projectId: true,
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
  findProjectPages(
    projectId: string,
    status?: string,
    search?: string,
  ): Promise<PageListItem[]>;
  findProjectPageTree(projectId: string): Promise<PageListItem[]>;
  findPageById(
    pageId: string,
    includeDeleted?: boolean,
  ): Promise<PageWithDetails | null>;
  findPageBySlug(
    projectId: string,
    slug: string,
  ): Promise<PageWithAuthor | null>;
  findChildPages(parentPageId: string): Promise<PageListItem[]>;
  findDeletedPages(
    parentPageId: string,
    projectId?: string,
  ): Promise<PageListItem[]>;
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
  restoreChildPages(parentPageId: string): Promise<number>;
  deletePage(pageId: string): Promise<Page>;
  incrementPageView(pageId: string): Promise<Page>;
  findProjectContext(projectId: string): Promise<{ id: string } | null>;
  findProjectMember(
    projectId: string,
    userId: string,
  ): Promise<{ role: string } | null>;
  getPageLabels(pageId: string): Promise<{ labelId: string; label: { id: string; name: string; color: string } }[]>;
  assignLabelsToPage(pageId: string, labelIds: string[]): Promise<void>;
  removeLabelFromPage(pageId: string, labelId: string): Promise<void>;
  replacePageLabels(pageId: string, labelIds: string[]): Promise<void>;
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
}> & {
  savedBy?: { id: string; name: string; avatar?: string | null };
};

export interface VersionQueryOptions {
  limit?: number;
  cursor?: string;
  eventType?: VersionEventType;
  labeledOnly?: boolean;
}

export interface PaginatedPageVersions {
  versions: PageVersionSummary[];
  total: number;
  nextCursor?: string | null;
}

export interface IHistoryRepository {
  findPageVersions(
    pageId: string,
    options?: VersionQueryOptions,
  ): Promise<PaginatedPageVersions>;
  findVersionById(versionId: string): Promise<
    | (PageVersion & {
        savedBy?: { id: string; name: string; avatar?: string | null };
      })
    | null
  >;
  createVersion(
    data:
      Prisma.PageVersionCreateInput | Prisma.PageVersionUncheckedCreateInput,
  ): Promise<PageVersion>;
  updateVersion(
    versionId: string,
    data:
      Prisma.PageVersionUpdateInput | Prisma.PageVersionUncheckedUpdateInput,
  ): Promise<PageVersion>;
  deleteVersion(versionId: string): Promise<PageVersion>;
}
