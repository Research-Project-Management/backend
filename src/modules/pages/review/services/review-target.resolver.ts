import { PrismaService, isUuid } from '@/core';
import {
  getRecordSpaceId,
  resolveActiveProjectId,
} from '@/modules/pages/core/utils/page-scope';
import { PageService } from '@/modules/pages/page/services/page.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';

export async function resolveReviewTarget(params: {
  scopeRepo: ScopeRepository;
  pageService: PageService;
  targetId: string;
  authSpace?: string | { id: string } | null;
  fallbackPrisma?: PrismaService;
}): Promise<{ docId?: string; spaceId?: string; pageId?: string }> {
  const { scopeRepo, pageService, targetId, authSpace } = params;
  const activeSpaceId = resolveActiveProjectId(authSpace);
  if (!isUuid(targetId)) {
    return { spaceId: activeSpaceId };
  }

  const doc = activeSpaceId
    ? await scopeRepo.findDocInProject(activeSpaceId, targetId)
    : null;
  if (doc) {
    return {
      docId: doc.id,
      spaceId: getRecordSpaceId(doc) || activeSpaceId,
      pageId: doc.pageId ?? undefined,
    };
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
    if (page && !page.deletedAt && page.rootDocId) {
      if (activeSpaceId && page.spaceId !== activeSpaceId) {
        return { spaceId: activeSpaceId };
      }
      return {
        docId: page.rootDocId,
        spaceId: page.spaceId || activeSpaceId,
        pageId: page.id,
      };
    }
  }

  const resolvedSpace = await pageService.resolveProjectId(targetId);
  if (activeSpaceId && resolvedSpace && resolvedSpace !== activeSpaceId) {
    return { spaceId: activeSpaceId };
  }
  return {
    docId: targetId,
    spaceId: activeSpaceId || resolvedSpace || undefined,
  };
}
