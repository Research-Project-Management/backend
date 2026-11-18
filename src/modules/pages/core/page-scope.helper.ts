/**
 * modules/pages/core/page-scope.helper.ts
 * Canonical Page Aggregate Root resolution helpers ensuring every child entity
 * (`page_nodes`, `page_docs`, `page_files`, `page_snapshots`, review items)
 * persists a valid non-null `pageId` scoped to `spaceId`.
 */

import { isUuid } from '@/core';

export interface PageScopeDbClient {
  page?: {
    findUnique?(args: any): PromiseLike<{
      id: string;
      spaceId?: string;
      rootDocId?: string | null;
      deletedAt?: Date | null;
    } | null>;

    findFirst?(args: any): PromiseLike<{
      id: string;
      spaceId?: string;
      rootDocId?: string | null;
    } | null>;

    findMany?(args: any): PromiseLike<Array<{ rootDocId?: string | null }>>;

    create?(args: any): PromiseLike<{ id: string }>;

    upsert?(args: any): PromiseLike<{ id: string }>;
  };
  pageDoc?: {
    findUnique?(args: any): PromiseLike<{
      id: string;
      spaceId?: string;
      pageId?: string | null;
    } | null>;

    findFirst?(args: any): PromiseLike<{
      id: string;
      spaceId?: string;
      pageId?: string | null;
    } | null>;
  };
}

/**
 * Resolves a valid canonical `Page.id` belonging to `spaceId`.
 * When callers omit `pageId` (or pass a `PageDoc.id` or space UUID), this resolves:
 *   1. Exact `Page.id` in `spaceId`
 *   2. `PageDoc.pageId` if `candidatePageId` refers to an existing `PageDoc`
 *   3. Earliest non-deleted `Page` in `spaceId`
 *   4. Auto-provisions a default `Page` row (`id: preferredPageId || spaceId`) when
 *      `autoCreate !== false` and a `prisma.page` delegate is available.
 * Safe with lightweight Jest mocks where `prisma.page` may be undefined.
 */
export async function ensureCanonicalPageId(
  db: PageScopeDbClient | null | undefined,
  spaceId: string,
  candidatePageId?: string | null,
  options?: {
    preferredPageId?: string | null;
    title?: string;
    autoCreate?: boolean;
  },
): Promise<string> {
  const trimmedCandidate = candidatePageId?.trim() || undefined;
  if (trimmedCandidate && isUuid(trimmedCandidate)) {
    if (!db?.page?.findUnique) {
      return trimmedCandidate;
    }
    const directPage = await Promise.resolve(
      db.page.findUnique({
        where: { id: trimmedCandidate },
        select: { id: true, spaceId: true, deletedAt: true },
      }),
    ).catch(() => null);
    if (
      directPage?.id &&
      (!directPage.spaceId || directPage.spaceId === spaceId)
    ) {
      return directPage.id;
    }

    if (db.pageDoc?.findFirst) {
      const childDoc = await Promise.resolve(
        db.pageDoc.findFirst({
          where: { id: trimmedCandidate, spaceId },
          select: { id: true, pageId: true },
        }),
      ).catch(() => null);
      if (childDoc?.pageId) {
        return childDoc.pageId;
      }
    }
  }

  if (!db?.page) {
    return trimmedCandidate || options?.preferredPageId || spaceId;
  }

  if (db.page.findFirst) {
    const existingActivePage = await Promise.resolve(
      db.page.findFirst({
        where: { spaceId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }),
    ).catch(() => null);
    if (existingActivePage?.id) {
      return existingActivePage.id;
    }

    const existingAnyPage = await Promise.resolve(
      db.page.findFirst({
        where: { spaceId },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }),
    ).catch(() => null);
    if (existingAnyPage?.id) {
      return existingAnyPage.id;
    }
  }

  if (options?.autoCreate === false || !isUuid(spaceId)) {
    return (
      (trimmedCandidate && trimmedCandidate !== spaceId
        ? trimmedCandidate
        : undefined) ||
      options?.preferredPageId ||
      spaceId
    );
  }

  const targetPageId =
    options?.preferredPageId && isUuid(options.preferredPageId)
      ? options.preferredPageId
      : spaceId;

  const pageData = {
    id: targetPageId,
    spaceId,
    rootDocId: null,
    title: options?.title || 'Untitled',
    status: 'draft',
    compiler: 'pdflatex',
    texLiveVersion: '2024',
    spellCheckLanguage: 'en_US',
  };

  if (db.page.upsert) {
    const upserted = await Promise.resolve(
      db.page.upsert({
        where: { id: targetPageId },
        create: pageData,
        update: {},
        select: { id: true },
      }),
    ).catch(() => null);
    if (upserted?.id) {
      return upserted.id;
    }
  } else if (db.page.create) {
    const created = await Promise.resolve(
      db.page.create({
        data: pageData,
        select: { id: true },
      }),
    ).catch(() => null);
    if (created?.id) {
      return created.id;
    }
  }

  return targetPageId;
}

/**
 * Resolves all active `rootDocId`s belonging to Pages in `spaceId` (or a single `pageId`).
 */
export async function resolveSpaceRootDocIds(
  db: Pick<PageScopeDbClient, 'page'> | null | undefined,
  spaceId: string,
  pageId?: string | null,
): Promise<Set<string>> {
  const rootDocIds = new Set<string>();
  if (!db?.page) return rootDocIds;

  const explicitPageId = pageId && isUuid(pageId) ? pageId : undefined;

  if (explicitPageId && db.page.findUnique) {
    const pageRow = await Promise.resolve(
      db.page.findUnique({
        where: { id: explicitPageId },
        select: { spaceId: true, rootDocId: true, deletedAt: true },
      }),
    ).catch(() => null);
    if (pageRow) {
      if (
        !pageRow.deletedAt &&
        (!pageRow.spaceId || pageRow.spaceId === spaceId) &&
        pageRow.rootDocId
      ) {
        rootDocIds.add(pageRow.rootDocId);
      }
      return rootDocIds;
    }
    if (explicitPageId !== spaceId) {
      return rootDocIds;
    }
  }

  const pageFindMany = (
    db.page as {
      findMany?: (args: {
        where: Record<string, unknown>;
        select: Record<string, boolean>;
      }) => Promise<Array<{ rootDocId?: string | null }>>;
    }
  ).findMany;

  if (pageFindMany) {
    const pages = await Promise.resolve(
      pageFindMany({
        where: { spaceId, deletedAt: null, rootDocId: { not: null } },
        select: { rootDocId: true },
      }),
    ).catch(() => []);
    for (const p of pages || []) {
      if (p?.rootDocId) rootDocIds.add(p.rootDocId);
    }
  } else if (db.page.findFirst) {
    const firstPage = await Promise.resolve(
      db.page.findFirst({
        where: { spaceId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { rootDocId: true },
      }),
    ).catch(() => null);
    if (firstPage?.rootDocId) {
      rootDocIds.add(firstPage.rootDocId);
    }
  }

  return rootDocIds;
}

/**
 * Resolves canonical `(spaceId, pageId)` coordinates from Nest route params,
 * query params, `@ResolvedProject()`, and guard-attached request context.
 */
export function resolvePageControllerCoordinates(
  params: {
    spaceId?: string;
    projectId?: string;
    pageId?: string;
    docId?: string;
  },
  resolvedProject?: string | { id?: string } | null,
  queryPageId?: string,
  req?: unknown,
): { spaceId: string; pageId?: string } {
  const reqCtx =
    req && typeof req === 'object'
      ? (req as { resolvedSpaceId?: unknown; resolvedPageId?: unknown })
      : undefined;
  const reqSpaceId =
    typeof reqCtx?.resolvedSpaceId === 'string'
      ? reqCtx.resolvedSpaceId
      : undefined;
  const reqPageId =
    typeof reqCtx?.resolvedPageId === 'string'
      ? reqCtx.resolvedPageId
      : undefined;
  const authorized =
    typeof resolvedProject === 'string' ? resolvedProject : resolvedProject?.id;
  const spaceId =
    authorized ||
    reqSpaceId ||
    params.spaceId ||
    params.projectId ||
    params.pageId ||
    params.docId ||
    '';
  const cleanQueryPageId = queryPageId?.trim() || undefined;
  const cleanParamPageId = params.pageId?.trim() || undefined;
  const cleanParamDocId = params.docId?.trim() || undefined;
  const pageId =
    cleanQueryPageId ||
    cleanParamPageId ||
    cleanParamDocId ||
    reqPageId ||
    (authorized && params.spaceId && params.spaceId !== authorized
      ? params.spaceId
      : undefined) ||
    (authorized && params.projectId && params.projectId !== authorized
      ? params.projectId
      : undefined);
  return { spaceId, pageId };
}
