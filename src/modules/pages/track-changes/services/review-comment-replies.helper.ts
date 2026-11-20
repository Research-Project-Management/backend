/**
 * modules/pages/track-changes/services/review-comment-replies.helper.ts
 * Co-located reply creation, update, and deletion operations supporting ReviewCommentsService.
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ResourceAccessPolicy, Role } from '@/modules/project/access';
import { AuthenticatedRequest, isUuid } from '@/core';
import { getRecordSpaceId } from '@/modules/pages/core/page-scope.helper';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';
import { TrackChangesRepository } from '../track-changes.repository';
import { CommentReply } from '../domain';
import { ReviewScopeRepository } from '../repositories/review-scope.repository';
import {
  assertCanModifyReviewItem,
  broadcastReviewProjectEvent,
} from './review.helpers';
import { reloadFormattedThread } from './review-comments.helper';

export async function executeAddCommentReply(params: {
  reviewScopeRepo: ReviewScopeRepository;
  userResolver: UserResolverService;
  trackChangesRepo?: TrackChangesRepository;
  eventEmitter?: EventEmitter2;
  targetProjectId?: string;
  resolvedDocId?: string;
  commentId: string;
  body: { content: string };
  req: AuthenticatedRequest;
}) {
  const {
    reviewScopeRepo,
    userResolver,
    trackChangesRepo,
    eventEmitter,
    targetProjectId,
    resolvedDocId,
    commentId,
    body,
    req,
  } = params;
  const userId = req?.user?.id || req?.user?.sub || null;
  if (!isUuid(commentId)) {
    throw new BadRequestException('A valid UUID is required for commentId');
  }
  if (!targetProjectId || !trackChangesRepo) {
    throw new NotFoundException(`Comment thread ${commentId} not found`);
  }

  const existingThread = await reviewScopeRepo.findThreadInProject(
    targetProjectId,
    commentId,
    resolvedDocId,
  );
  if (!existingThread) {
    throw new NotFoundException(`Comment thread ${commentId} not found`);
  }
  if (existingThread.isResolved) {
    throw new BadRequestException(
      'Cannot add reply to a resolved comment thread',
    );
  }

  const replyEntity = CommentReply.create({
    threadId: commentId,
    content: body.content,
    createdById: isUuid(userId) ? userId : null,
  });
  await trackChangesRepo.addCommentReply(commentId, replyEntity);

  const { thread, commentPayload } = await reloadFormattedThread({
    reviewScopeRepo,
    userResolver,
    projectId: targetProjectId,
    commentId,
    throwIfMissing: true,
  });

  broadcastReviewProjectEvent(
    eventEmitter,
    getRecordSpaceId(thread),
    'comment:reply-added',
    { docId: thread!.docId, commentId: thread!.id, comment: commentPayload },
  );

  return { comment: commentPayload };
}

export async function executeUpdateCommentReply(params: {
  reviewScopeRepo: ReviewScopeRepository;
  userResolver: UserResolverService;
  trackChangesRepo?: TrackChangesRepository;
  eventEmitter?: EventEmitter2;
  targetProjectId?: string;
  resolvedDocId?: string;
  commentId: string;
  replyId: string;
  body: { content: string };
  req?: AuthenticatedRequest;
  role?: Role;
}) {
  const {
    reviewScopeRepo,
    userResolver,
    trackChangesRepo,
    eventEmitter,
    targetProjectId,
    resolvedDocId,
    commentId,
    replyId,
    body,
    req,
    role,
  } = params;
  if (!isUuid(replyId) || !isUuid(commentId)) {
    throw new BadRequestException(
      'Valid UUIDs are required for commentId and replyId',
    );
  }
  const trimmed = typeof body?.content === 'string' ? body.content.trim() : '';
  if (!trimmed || trimmed.length > 10000) {
    throw new BadRequestException(
      'Reply content must be between 1 and 10000 characters',
    );
  }
  if (!targetProjectId) {
    throw new NotFoundException(`Reply ${replyId} not found`);
  }

  const existingThread = await reviewScopeRepo.findThreadInProject(
    targetProjectId,
    commentId,
    resolvedDocId,
  );
  const existingReply = existingThread?.replies?.find((r) => r.id === replyId);
  if (!existingThread || !existingReply) {
    throw new NotFoundException(`Reply ${replyId} not found`);
  }
  if (existingThread.isResolved) {
    throw new ConflictException({
      statusCode: 409,
      code: 'COMMENT_THREAD_RESOLVED',
      message: 'Cannot edit reply in a resolved comment thread',
    });
  }

  if (existingReply.createdById) {
    const userId = req?.user?.id || req?.user?.sub;
    const reqCtx = req as
      { projectMember?: { permissionBitmask?: string } } | undefined;
    new ResourceAccessPolicy().assertCanModifyComment(
      {
        userId: userId ?? '',
        role: role ?? Role.REVIEWER,
        permissionBitmask: reqCtx?.projectMember?.permissionBitmask,
      },
      { id: replyId, authorId: existingReply.createdById },
      'update',
    );
  }

  if (typeof reviewScopeRepo.updateReplyInThread === 'function') {
    await reviewScopeRepo.updateReplyInThread(
      existingThread.id,
      replyId,
      trimmed,
    );
  } else if (trackChangesRepo?.updateCommentReply) {
    await trackChangesRepo.updateCommentReply(
      existingThread.id,
      replyId,
      trimmed,
    );
  }

  const { commentPayload } = await reloadFormattedThread({
    reviewScopeRepo,
    userResolver,
    projectId: targetProjectId,
    commentId,
    includeAvatar: true,
    includeDocId: false,
  });

  broadcastReviewProjectEvent(
    eventEmitter,
    targetProjectId,
    'comment:reply-updated',
    {
      docId: existingThread.docId,
      commentId: existingThread.id,
      replyId,
      comment: commentPayload,
    },
  );
  return { comment: commentPayload };
}

export async function executeDeleteCommentReply(params: {
  reviewScopeRepo: ReviewScopeRepository;
  userResolver: UserResolverService;
  eventEmitter?: EventEmitter2;
  targetProjectId?: string;
  resolvedDocId?: string;
  commentId: string;
  replyId: string;
  req?: AuthenticatedRequest;
  role?: Role;
}) {
  const {
    reviewScopeRepo,
    userResolver,
    eventEmitter,
    targetProjectId,
    resolvedDocId,
    commentId,
    replyId,
    req,
    role,
  } = params;
  if (!isUuid(replyId) || !isUuid(commentId)) {
    throw new BadRequestException(
      'Valid UUIDs are required for commentId and replyId',
    );
  }
  if (!targetProjectId) {
    throw new NotFoundException(`Reply ${replyId} not found`);
  }

  const existingThread = await reviewScopeRepo.findThreadInProject(
    targetProjectId,
    commentId,
    resolvedDocId,
  );
  const existingReply = existingThread?.replies?.find((r) => r.id === replyId);
  if (!existingThread || !existingReply) {
    throw new NotFoundException(`Reply ${replyId} not found`);
  }

  const userId = req?.user?.id || req?.user?.sub;
  if (userId || role) {
    const reqCtx = req as
      { projectMember?: { permissionBitmask?: string } } | undefined;
    if (existingReply.createdById && role !== Role.COORDINATOR) {
      new ResourceAccessPolicy().assertCanModifyComment(
        {
          userId: userId ?? '',
          role: role ?? Role.REVIEWER,
          permissionBitmask: reqCtx?.projectMember?.permissionBitmask,
        },
        { id: replyId, authorId: existingReply.createdById },
        'delete',
      );
    } else {
      assertCanModifyReviewItem(
        existingReply.createdById,
        userId,
        role,
        'Only the reply author or a coordinator/owner can delete this reply',
      );
    }
  }

  await reviewScopeRepo
    .deleteReplyInThread(existingThread.id, replyId)
    .catch(() => false);

  broadcastReviewProjectEvent(
    eventEmitter,
    targetProjectId,
    'comment:reply-deleted',
    { docId: existingThread.docId, commentId: existingThread.id, replyId },
  );

  const { commentPayload } = await reloadFormattedThread({
    reviewScopeRepo,
    userResolver,
    projectId: targetProjectId,
    commentId,
    includeAvatar: true,
    includeDocId: false,
  });

  return { success: true, comment: commentPayload };
}
