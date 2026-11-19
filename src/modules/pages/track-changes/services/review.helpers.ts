/**
 * modules/pages/track-changes/services/review.helpers.ts
 * Shared validation, formatting, and resolution helpers for Review services and controllers.
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  PageCommentReply,
  PageCommentThread,
  PageTrackChange,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import {
  resolveActiveProjectId,
  getRecordSpaceId,
} from '@/modules/pages/core/page-scope.helper';
import { PageService } from '@/modules/pages/core/services/page.service';
import { Role } from '@/modules/project/access';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';

export { resolveActiveProjectId };

export type ResolvedUserMap = Map<
  string,
  { id: string; name: string; avatar?: string }
>;

export type ThreadWithReplies = PageCommentThread & {
  replies?: PageCommentReply[];
};

export function broadcastReviewProjectEvent(
  eventEmitter: EventEmitter2 | undefined,
  projectId: string | null | undefined,
  event: string,
  payload: unknown,
): void {
  if (!projectId || !eventEmitter) return;
  try {
    eventEmitter.emit('manuscripts.project.event', {
      projectId,
      event,
      payload,
    });
  } catch {
    // Non-blocking real-time broadcast error ignored
  }
}

export async function resolveReviewDocAndProject(params: {
  pageScopeRepo: ScopeRepository;
  pageService: PageService;
  pageId: string;
  authorizedProjectId?: string | { id: string } | null;
  fallbackPrisma?: PrismaService;
}): Promise<{ docId?: string; projectId?: string; pageId?: string }> {
  const { pageScopeRepo, pageService, pageId, authorizedProjectId } = params;
  const activeProjectId =
    pageService.resolveActiveProjectId(authorizedProjectId);
  if (!isUuid(pageId)) {
    return { projectId: activeProjectId };
  }
  const doc = activeProjectId
    ? await pageScopeRepo.findDocInProject(activeProjectId, pageId)
    : null;
  if (doc) {
    return {
      docId: doc.id,
      projectId: getRecordSpaceId(doc) || activeProjectId,
      pageId: doc.pageId ?? undefined,
    };
  }

  const prisma =
    typeof pageScopeRepo.getPrisma === 'function'
      ? pageScopeRepo.getPrisma()
      : params.fallbackPrisma;
  if (prisma?.page?.findUnique) {
    const page = await Promise.resolve(
      prisma.page.findUnique({
        where: { id: pageId },
        select: { id: true, spaceId: true, rootDocId: true, deletedAt: true },
      }),
    ).catch(() => null);
    if (page && !page.deletedAt && page.rootDocId) {
      return {
        docId: page.rootDocId,
        projectId: page.spaceId || activeProjectId,
        pageId: page.id,
      };
    }
  }

  const resolvedProj = await pageService.resolveProjectId(pageId);
  return { docId: pageId, projectId: resolvedProj || activeProjectId };
}

export function validateCommentRange(
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

export function assertCanModifyReviewItem(
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

export function formatCommentThreadDto(
  t: ThreadWithReplies,
  userMap: ResolvedUserMap,
  options?: { includeAvatar?: boolean; includeDocId?: boolean },
) {
  const threadUser = t.createdById ? userMap.get(t.createdById) : undefined;
  const includeAvatar = options?.includeAvatar ?? false;
  const includeDocId = options?.includeDocId ?? true;

  return {
    id: t.id,
    page: t.docId,
    projectPageId: t.docId,
    ...(includeDocId ? { docId: t.docId } : {}),
    author: {
      id: t.createdById || 'anonymous',
      name: threadUser?.name || 'Collaborator',
      ...(includeAvatar ? { avatar: threadUser?.avatar || '' } : {}),
    },
    content: t.quote || '',
    line: t.startLine,
    lineEnd: t.endLine,
    status: t.isResolved ? 'resolved' : 'open',
    replies: (t.replies || []).map((r) => {
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
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function formatSuggestionItemDto(
  s: PageTrackChange,
  userMap: ResolvedUserMap,
) {
  const authorUser = s.createdById ? userMap.get(s.createdById) : undefined;
  return {
    id: s.id,
    pageId: s.docId,
    projectPageId: s.docId,
    authorId: s.createdById || 'anonymous',
    author: {
      id: s.createdById || 'anonymous',
      name: authorUser?.name || 'Collaborator',
      email: '',
    },
    type: s.type,
    originalText: s.type === 'delete' ? s.text : '',
    suggestedText: s.type === 'insert' ? s.text : '',
    fromLine: (s.startLine ?? 0) + 1,
    fromColumn: s.startCol,
    toLine: (s.endLine ?? s.startLine ?? 0) + 1,
    toColumn: s.endCol,
    description: null,
    status: s.status,
    resolvedById: s.resolvedById,
    resolvedAt: s.resolvedAt ? s.resolvedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
