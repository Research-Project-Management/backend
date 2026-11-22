import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import {
  getRecordSpaceId,
  resolveActiveProjectId,
} from '@/modules/pages/core/page-scope.helper';
import { PageService } from '@/modules/pages/core/services/page.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { Role } from '@/modules/project/access';

export {
  decodeAnchorBase64,
  encodeAnchorBase64,
  toCommentDto,
  toSuggestionDto,
  type ResolvedUserMap,
} from '../mappers/review.mapper';

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
      return {
        docId: page.rootDocId,
        spaceId: page.spaceId || activeSpaceId,
        pageId: page.id,
      };
    }
  }

  const resolvedSpace = await pageService.resolveProjectId(targetId);
  return { docId: targetId, spaceId: resolvedSpace || activeSpaceId };
}

export function validateCommentLines(
  line?: number,
  lineEnd?: number,
): { startLine: number; endLine: number } {
  const startLine = line ?? 1;
  const endLine = lineEnd ?? startLine;
  if (startLine < 1 || endLine < startLine) {
    throw new BadRequestException(
      'Invalid comment range: startLine must be >= 1 and endLine >= startLine',
    );
  }
  return { startLine, endLine };
}

export function validateSuggestionRange(body: {
  fromLine?: number;
  toLine?: number;
  fromColumn?: number;
  toColumn?: number;
}): {
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
} {
  const fromLine = body.fromLine ?? 1;
  const toLine = body.toLine ?? fromLine;
  const startCol = body.fromColumn ?? 0;
  const endCol = body.toColumn ?? 0;
  if (fromLine < 1 || toLine < fromLine || startCol < 0 || endCol < 0) {
    throw new BadRequestException(
      'Invalid suggestion range: startLine >= 1, endLine >= startLine, and columns >= 0 are required',
    );
  }
  return {
    startLine: fromLine - 1,
    endLine: toLine - 1,
    startCol,
    endCol,
  };
}

export function assertCanModifyItem(
  authorId: string | null | undefined,
  userId: string | null | undefined,
  role: Role | undefined,
  message: string,
): void {
  const isAuthor = authorId === userId;
  const isPrivileged = role === Role.COORDINATOR || role === Role.OWNER;
  if (!isAuthor && !isPrivileged) {
    throw new ForbiddenException({
      statusCode: 403,
      code: 'ROLE_INSUFFICIENT',
      message,
    });
  }
}
