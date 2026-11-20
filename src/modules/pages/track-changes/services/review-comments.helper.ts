/**
 * modules/pages/track-changes/services/review-comments.helper.ts
 * Domain payload builders and thread reload/broadcast helpers supporting ReviewCommentsService.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthenticatedRequest, isUuid } from '@/core';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';
import { TrackChangesRepository } from '../track-changes.repository';
import { CommentThread, TextRangeVo } from '../domain';
import { ReviewScopeRepository } from '../repositories/review-scope.repository';
import {
  broadcastReviewProjectEvent,
  formatCommentThreadDto,
  validateCommentRange,
  type ResolvedUserMap,
  type ThreadWithReplies,
} from './review.helpers';

export function formatDomainCommentThread(
  t: CommentThread,
  userMap: ResolvedUserMap,
) {
  const creator = t.createdById ? userMap.get(t.createdById) : undefined;
  return {
    id: t.id,
    page: t.docId,
    projectPageId: t.docId,
    author: {
      id: t.createdById || 'anonymous',
      name: creator?.name || 'Collaborator',
      avatar: creator?.avatar,
    },
    content: t.quote || '',
    line: t.range.startLine,
    lineEnd: t.range.endLine,
    status: t.isResolved ? 'resolved' : 'open',
    replies: t.replies.map((r) => {
      const replyUser = r.createdById ? userMap.get(r.createdById) : undefined;
      return {
        id: r.id,
        author: {
          id: r.createdById || 'anonymous',
          name: replyUser?.name || 'Collaborator',
          avatar: replyUser?.avatar,
        },
        content: r.content,
        createdAt: r.createdAt.toISOString(),
      };
    }),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export async function reloadFormattedThread(params: {
  reviewScopeRepo: ReviewScopeRepository;
  userResolver: UserResolverService;
  projectId: string;
  commentId: string;
  extraUserIds?: (string | null | undefined)[];
  includeAvatar?: boolean;
  includeDocId?: boolean;
  throwIfMissing?: boolean;
}): Promise<{
  thread: ThreadWithReplies | null;
  userMap: ResolvedUserMap;
  commentPayload: ReturnType<typeof formatCommentThreadDto> | null;
}> {
  const updated = await params.reviewScopeRepo.findThreadInProject(
    params.projectId,
    params.commentId,
  );
  if (!updated) {
    if (params.throwIfMissing) {
      throw new NotFoundException(
        `Comment thread ${params.commentId} not found`,
      );
    }
    return { thread: null, userMap: new Map(), commentPayload: null };
  }

  const userMap = await params.userResolver.resolveUserNames([
    updated.createdById,
    ...(params.extraUserIds ?? []),
    ...(updated.replies || []).map((r) => r.createdById),
  ]);
  const commentPayload = formatCommentThreadDto(updated, userMap, {
    includeAvatar: params.includeAvatar,
    includeDocId: params.includeDocId,
  });
  return { thread: updated, userMap, commentPayload };
}

export function emitCommentProjectEvent(
  eventEmitter: EventEmitter2 | undefined,
  projectId: string | null | undefined,
  event: string,
  payload: unknown,
): void {
  broadcastReviewProjectEvent(eventEmitter, projectId, event, payload);
}

export async function executeCreateComment(params: {
  trackChangesRepo?: TrackChangesRepository;
  userResolver: UserResolverService;
  eventEmitter?: EventEmitter2;
  resolvedProj?: string | null;
  resolvedPageId?: string | null;
  targetDocId: string;
  body: { content: string; line?: number; lineEnd?: number };
  req: AuthenticatedRequest;
}) {
  const {
    trackChangesRepo,
    userResolver,
    eventEmitter,
    resolvedProj,
    resolvedPageId,
    targetDocId,
    body,
    req,
  } = params;
  const userId = req?.user?.id || req?.user?.sub || null;
  if (!resolvedProj || !isUuid(resolvedProj) || !isUuid(targetDocId)) {
    throw new BadRequestException(
      'Valid pageId and associated project required to create a comment',
    );
  }
  if (!trackChangesRepo) {
    throw new BadRequestException('TrackChanges repository not available');
  }

  const userMap = await userResolver.resolveUserNames([userId]);
  const resolvedUser = userId ? userMap.get(userId) : undefined;
  const authorName =
    resolvedUser?.name ||
    req?.user?.name ||
    req?.user?.email?.split('@')[0] ||
    'Collaborator';

  const { startLine, endLine } = validateCommentRange(body.line, body.lineEnd);
  const saved = await trackChangesRepo.saveCommentThread(
    CommentThread.create({
      projectId: resolvedProj,
      spaceId: resolvedProj,
      pageId: resolvedPageId ?? null,
      docId: targetDocId,
      quote: body.content,
      range: TextRangeVo.create({ startLine, startCol: 0, endLine, endCol: 0 }),
      createdById: isUuid(userId) ? userId : null,
    }),
  );

  const commentPayload = {
    id: saved.id,
    page: targetDocId,
    projectPageId: targetDocId,
    docId: targetDocId,
    author: {
      id: userId || saved.createdById || 'anonymous',
      name: authorName,
    },
    content: saved.quote || '',
    line: saved.range.startLine,
    lineEnd: saved.range.endLine,
    status: 'open',
    replies: [],
    createdAt: saved.createdAt.toISOString(),
    updatedAt: saved.updatedAt.toISOString(),
  };

  broadcastReviewProjectEvent(eventEmitter, resolvedProj, 'comment:created', {
    docId: targetDocId,
    comment: commentPayload,
  });

  return { comment: commentPayload };
}
