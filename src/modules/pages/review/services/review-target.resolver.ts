import { PrismaService, isUuid } from '@/core';
import {
  getRecordSpaceId,
  resolveActiveProjectId,
} from '@/modules/pages/core';
import { ScopeRepository } from '@/modules/pages/docstore';
import { PageService } from '@/modules/pages/page';

export interface ResolvedReviewTarget {
  docId?: string;
  spaceId?: string;
  pageId?: string;
  crossSpaceMismatch?: boolean;
}

export async function resolveReviewTarget(params: {
  scopeRepo: ScopeRepository;
  pageService: PageService;
  targetId: string;
  authSpace?: string | { id: string } | null;
  routeSpaceId?: string;
  bodySpaceId?: string;
  fallbackPrisma?: PrismaService;
}): Promise<ResolvedReviewTarget> {
  const {
    scopeRepo,
    pageService,
    targetId,
    authSpace,
    routeSpaceId,
    bodySpaceId,
  } = params;
  const activeSpaceId =
    resolveActiveProjectId(authSpace) ||
    (typeof pageService.resolveActiveProjectId === 'function'
      ? pageService.resolveActiveProjectId(authSpace)
      : undefined) ||
    routeSpaceId?.trim() ||
    bodySpaceId?.trim() ||
    undefined;

  if (!isUuid(targetId)) {
    return { spaceId: activeSpaceId };
  }

  if (activeSpaceId) {
    const doc = await scopeRepo.findDocInProject(activeSpaceId, targetId);
    if (doc) {
      return {
        docId: doc.id,
        spaceId: getRecordSpaceId(doc) || activeSpaceId,
        pageId: doc.pageId ?? undefined,
      };
    }
  }

  const prisma =
    typeof scopeRepo.getPrisma === 'function'
      ? scopeRepo.getPrisma()
      : params.fallbackPrisma;
  if (prisma?.page?.findUnique) {
    const page = await Promise.resolve(
      prisma.page.findUnique({
        where: { id: targetId },
        select: { id: true, spaceId: true, rootDocId: true, deletedAt: true },
      }),
    ).catch(() => null);
    if (page && !page.deletedAt) {
      if (activeSpaceId && page.spaceId && page.spaceId !== activeSpaceId) {
        return { spaceId: activeSpaceId, crossSpaceMismatch: true };
      }
      if (page.rootDocId) {
        return {
          docId: page.rootDocId,
          spaceId: page.spaceId || activeSpaceId,
          pageId: page.id,
        };
      }
    }
  }

  const resolvedSpace = await pageService.resolveProjectId(targetId);
  if (activeSpaceId && resolvedSpace && resolvedSpace !== activeSpaceId) {
    return { spaceId: activeSpaceId, crossSpaceMismatch: true };
  }

  const finalSpaceId = activeSpaceId || resolvedSpace || undefined;
  if (!activeSpaceId && finalSpaceId) {
    const doc = await scopeRepo.findDocInProject(finalSpaceId, targetId);
    if (doc) {
      return {
        docId: doc.id,
        spaceId: getRecordSpaceId(doc) || finalSpaceId,
        pageId: doc.pageId ?? undefined,
      };
    }
  }

  return {
    docId: targetId,
    spaceId: finalSpaceId,
  };
}
