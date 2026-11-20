import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PageTrackChange } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import {
  getRecordSpaceId,
  resolveActiveProjectId,
} from '@/modules/pages/core/page-scope.helper';
import { PageService } from '@/modules/pages/core/services/page.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { Role } from '@/modules/project/access';
import { CommentThread, TrackChange } from '../domain';
import type { ThreadWithReplies } from '../review.repository';

export type ResolvedUserMap = Map<
  string,
  { id: string; name: string; avatar?: string }
>;

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

export function toCommentDto(
  thread: CommentThread | ThreadWithReplies,
  userMap: ResolvedUserMap,
  options?: { includeAvatar?: boolean; includeDocId?: boolean },
) {
  const creator = thread.createdById
    ? userMap.get(thread.createdById)
    : undefined;
  const includeAvatar = options?.includeAvatar ?? false;
  const includeDocId = options?.includeDocId ?? true;
  const line =
    thread instanceof CommentThread ? thread.range.startLine : thread.startLine;
  const lineEnd =
    thread instanceof CommentThread ? thread.range.endLine : thread.endLine;

  return {
    id: thread.id,
    page: thread.docId,
    projectPageId: thread.docId,
    ...(includeDocId ? { docId: thread.docId } : {}),
    author: {
      id: thread.createdById || 'anonymous',
      name: creator?.name || 'Collaborator',
      ...(includeAvatar ? { avatar: creator?.avatar || '' } : {}),
    },
    content: thread.quote || '',
    line,
    lineEnd,
    status: thread.isResolved ? 'resolved' : 'open',
    replies: (thread.replies || []).map((r) => {
      const replyUser = r.createdById ? userMap.get(r.createdById) : undefined;
      return {
        id: r.id,
        author: {
          id: r.createdById || 'anonymous',
          name: replyUser?.name || 'Collaborator',
          ...(includeAvatar ? { avatar: replyUser?.avatar || '' } : {}),
        },
        content: r.content,
        createdAt: r.createdAt.toISOString(),
      };
    }),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export function toSuggestionDto(
  change: TrackChange | PageTrackChange,
  userMap: ResolvedUserMap,
) {
  const creator = change.createdById
    ? userMap.get(change.createdById)
    : undefined;
  const isEntity = change instanceof TrackChange;
  const startLine = isEntity ? change.range.startLine : (change.startLine ?? 0);
  const startCol = isEntity ? change.range.startCol : change.startCol;
  const endLine = isEntity
    ? change.range.endLine
    : (change.endLine ?? change.startLine ?? 0);
  const endCol = isEntity ? change.range.endCol : change.endCol;

  return {
    id: change.id,
    pageId: change.docId,
    page: change.docId,
    projectPageId: change.docId,
    authorId: change.createdById || 'anonymous',
    author: {
      id: change.createdById || 'anonymous',
      name: creator?.name || 'Collaborator',
      ...(creator?.avatar ? { avatar: creator.avatar } : {}),
      email: '',
    },
    type: change.type,
    originalText: change.type === 'delete' ? change.text : '',
    suggestedText: change.type === 'insert' ? change.text : '',
    text: change.text,
    fromLine: startLine + 1,
    fromColumn: startCol,
    toLine: endLine + 1,
    toColumn: endCol,
    description: null,
    status: change.status,
    resolvedById: change.resolvedById,
    resolvedAt: change.resolvedAt ? change.resolvedAt.toISOString() : null,
    createdAt: change.createdAt.toISOString(),
    updatedAt: change.updatedAt.toISOString(),
  };
}
