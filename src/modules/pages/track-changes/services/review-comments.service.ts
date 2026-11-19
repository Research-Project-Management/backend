/**
 * modules/pages/track-changes/services/review-comments.service.ts
 * Application service encapsulating inline comment threads, replies, resolution,
 * real-time event emission, and non-blocking mention/reply notifications.
 */

import {
  Injectable,
  Optional,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ProjectRolePolicy,
  ResourceAccessPolicy,
  Role,
} from '@/modules/project/access';
import { AuthenticatedRequest, isUuid } from '@/core';
import { getRecordSpaceId } from '@/modules/pages/core/page-scope.helper';
import { PageService } from '@/modules/pages/core/services/page.service';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { TrackChangesRepository } from '../track-changes.repository';
import { ReviewScopeRepository } from '../repositories/review-scope.repository';
import { ReviewNotificationDispatcher } from './review-notification.dispatcher';
import {
  broadcastReviewProjectEvent,
  resolveReviewDocAndProject,
  assertCanModifyReviewItem,
} from './review.helpers';
import {
  formatDomainCommentThread,
  reloadFormattedThread,
  executeCreateComment,
  dispatchCommentResolvedNotification,
} from './review-comments.helper';
import {
  executeAddCommentReply,
  executeUpdateCommentReply,
  executeDeleteCommentReply,
} from './review-comment-replies.helper';

@Injectable()
export class ReviewCommentsService {
  constructor(
    private readonly reviewScopeRepo: ReviewScopeRepository,
    private readonly pageScopeRepo: ScopeRepository,
    private readonly userResolver: UserResolverService,
    private readonly pageService: PageService,
    private readonly notificationDispatcher: ReviewNotificationDispatcher,
    @Optional() private readonly trackChangesRepo?: TrackChangesRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  private resolveDoc(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return resolveReviewDocAndProject({
      pageScopeRepo: this.pageScopeRepo,
      pageService: this.pageService,
      pageId,
      authorizedProjectId,
      fallbackPrisma: this.reviewScopeRepo.getPrisma?.(),
    });
  }

  private async loadThreadOrThrow(
    pageId: string,
    commentId: string,
    routeProjectId?: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }
    const { docId: resolvedDocId, projectId: resolvedProj } =
      await this.resolveDoc(pageId, routeProjectId || authorizedProjectId);
    const targetProjectId =
      resolvedProj ||
      this.pageService.resolveActiveProjectId(authorizedProjectId) ||
      routeProjectId;
    const thread = targetProjectId
      ? await this.reviewScopeRepo.findThreadInProject(
          targetProjectId,
          commentId,
          resolvedDocId,
        )
      : null;
    if (!thread) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }
    return { targetProjectId: targetProjectId!, thread };
  }

  private assertAuthorOrPolicy(
    req: AuthenticatedRequest | undefined,
    role: Role | undefined,
    itemId: string,
    authorId: string | null | undefined,
    action: 'update' | 'delete',
    fallbackMessage: string,
  ): void {
    const userId = req?.user?.id || req?.user?.sub;
    const reqCtx = req as
      { projectMember?: { permissionBitmask?: string } } | undefined;
    const allowBypassDelete = action === 'delete' && role === Role.COORDINATOR;
    if (authorId && !allowBypassDelete) {
      new ResourceAccessPolicy().assertCanModifyComment(
        {
          userId: userId ?? '',
          role: role ?? Role.REVIEWER,
          permissionBitmask: reqCtx?.projectMember?.permissionBitmask,
        },
        { id: itemId, authorId },
        action,
      );
      return;
    }
    assertCanModifyReviewItem(authorId, userId, role, fallbackMessage);
  }

  public async getComments(
    pageId: string,
    status?: string,
    routeProjectId?: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) return { comments: [] };
    try {
      const { docId: resolvedDocId, projectId: resolvedProj } =
        await this.resolveDoc(pageId, authorizedProjectId || routeProjectId);
      const targetProjectId =
        resolvedProj ||
        this.pageService.resolveActiveProjectId(authorizedProjectId) ||
        routeProjectId;
      const targetDocId = resolvedDocId || pageId;
      if (!targetProjectId || !this.trackChangesRepo) return { comments: [] };

      const isResolved =
        status === 'resolved' ? true : status === 'open' ? false : undefined;
      const domainThreads = await this.trackChangesRepo.listThreadsByDoc(
        targetProjectId,
        targetDocId,
        isResolved,
      );

      const userIds: (string | null | undefined)[] = [];
      for (const t of domainThreads) {
        userIds.push(t.createdById);
        for (const r of t.replies || []) userIds.push(r.createdById);
      }
      const userMap = await this.userResolver.resolveUserNames(userIds);
      return {
        comments: domainThreads.map((t) =>
          formatDomainCommentThread(t, userMap),
        ),
      };
    } catch {
      return { comments: [] };
    }
  }

  public async createComment(
    pageId: string,
    body: {
      content: string;
      line?: number;
      lineEnd?: number;
      spaceId?: string;
    },
    req: AuthenticatedRequest,
    routeProjectId?: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    const activeProj =
      this.pageService.resolveActiveProjectId(authorizedProjectId) ||
      routeProjectId;
    const {
      docId: resolvedDocId,
      projectId: docProjId,
      pageId: resolvedPageId,
    } = await this.resolveDoc(pageId, activeProj || body?.spaceId);
    const resolvedProj =
      docProjId ||
      activeProj ||
      body?.spaceId ||
      (await this.pageService.resolveProjectId(pageId));

    return executeCreateComment({
      trackChangesRepo: this.trackChangesRepo,
      userResolver: this.userResolver,
      notificationDispatcher: this.notificationDispatcher,
      eventEmitter: this.eventEmitter,
      resolvedProj,
      resolvedPageId,
      targetDocId: resolvedDocId || pageId,
      body,
      req,
    });
  }

  public async updateComment(
    pageId: string,
    commentId: string,
    body: {
      content?: string;
      status?: 'open' | 'resolved';
      resolved?: boolean;
    },
    req: AuthenticatedRequest,
    routeProjectId?: string,
    authorizedProjectId?: string | { id: string } | null,
    role?: Role,
  ) {
    const userId = req?.user?.id || req?.user?.sub;
    const { thread } = await this.loadThreadOrThrow(
      pageId,
      commentId,
      routeProjectId,
      authorizedProjectId,
    );

    if (body.resolved !== undefined || body.status !== undefined) {
      if (
        !ProjectRolePolicy.satisfiesMinRole(
          role ?? Role.REVIEWER,
          Role.CONTRIBUTOR,
        )
      ) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'ROLE_INSUFFICIENT',
          message: 'Only contributors or higher can resolve or reopen comments',
        });
      }
    }

    if (body.content !== undefined) {
      this.assertAuthorOrPolicy(
        req,
        role,
        commentId,
        thread.createdById,
        'update',
        'Only the comment author or a coordinator/owner can edit this comment',
      );
    }

    const isResolved =
      body.resolved !== undefined
        ? Boolean(body.resolved)
        : body.status !== undefined
          ? body.status === 'resolved'
          : thread.isResolved;
    const quote = body.content !== undefined ? body.content : thread.quote;
    const threadProjectId = getRecordSpaceId(thread);

    await this.reviewScopeRepo.updateThreadInProject(
      threadProjectId,
      commentId,
      { quote, isResolved },
    );

    const {
      thread: updated,
      userMap,
      commentPayload,
    } = await reloadFormattedThread({
      reviewScopeRepo: this.reviewScopeRepo,
      userResolver: this.userResolver,
      projectId: threadProjectId,
      commentId,
      throwIfMissing: true,
    });

    broadcastReviewProjectEvent(
      this.eventEmitter,
      getRecordSpaceId(updated),
      'comment:updated',
      { docId: updated!.docId, comment: commentPayload },
    );

    if (
      userId &&
      isUuid(userId) &&
      (body.resolved !== undefined || body.status !== undefined) &&
      isResolved !== thread.isResolved
    ) {
      await dispatchCommentResolvedNotification({
        dispatcher: this.notificationDispatcher,
        label: 'updateComment:resolved',
        thread: updated!,
        isResolved,
        actorId: userId,
        fallbackProjectId: threadProjectId,
        userMap,
      });
    }

    return { comment: commentPayload };
  }

  public async deleteComment(
    pageId: string,
    commentId: string,
    req: AuthenticatedRequest,
    routeProjectId?: string,
    authorizedProjectId?: string | { id: string } | null,
    role?: Role,
  ) {
    const { thread: existing } = await this.loadThreadOrThrow(
      pageId,
      commentId,
      routeProjectId,
      authorizedProjectId,
    );

    this.assertAuthorOrPolicy(
      req,
      role,
      commentId,
      existing.createdById,
      'delete',
      'Only the comment author or a coordinator/owner can delete this comment',
    );

    const existingProjectId = getRecordSpaceId(existing);
    await this.reviewScopeRepo.deleteThreadInProject(
      existingProjectId,
      commentId,
    );
    broadcastReviewProjectEvent(
      this.eventEmitter,
      existingProjectId,
      'comment:deleted',
      { docId: existing.docId, commentId },
    );
    return { success: true };
  }

  public async addCommentReply(
    pageId: string,
    commentId: string,
    body: { content: string },
    req: AuthenticatedRequest,
    routeProjectId?: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDoc(pageId, routeProjectId || authorizedProjectId);
    return executeAddCommentReply({
      reviewScopeRepo: this.reviewScopeRepo,
      userResolver: this.userResolver,
      notificationDispatcher: this.notificationDispatcher,
      trackChangesRepo: this.trackChangesRepo,
      eventEmitter: this.eventEmitter,
      targetProjectId,
      resolvedDocId,
      commentId,
      body,
      req,
    });
  }

  public async updateCommentReply(
    pageId: string,
    commentId: string,
    replyId: string,
    body: { content: string },
    routeProjectId?: string,
    req?: AuthenticatedRequest,
    authorizedProjectId?: string | { id: string } | null,
    role?: Role,
  ) {
    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDoc(pageId, routeProjectId || authorizedProjectId);
    return executeUpdateCommentReply({
      reviewScopeRepo: this.reviewScopeRepo,
      userResolver: this.userResolver,
      trackChangesRepo: this.trackChangesRepo,
      eventEmitter: this.eventEmitter,
      targetProjectId,
      resolvedDocId,
      commentId,
      replyId,
      body,
      req,
      role,
    });
  }

  public async deleteCommentReply(
    pageId: string,
    commentId: string,
    replyId: string,
    routeProjectId?: string,
    req?: AuthenticatedRequest,
    authorizedProjectId?: string | { id: string } | null,
    role?: Role,
  ) {
    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDoc(pageId, routeProjectId || authorizedProjectId);
    return executeDeleteCommentReply({
      reviewScopeRepo: this.reviewScopeRepo,
      userResolver: this.userResolver,
      eventEmitter: this.eventEmitter,
      targetProjectId,
      resolvedDocId,
      commentId,
      replyId,
      req,
      role,
    });
  }

  public async resolveComment(
    pageId: string,
    commentId: string,
    body: { resolved?: boolean },
    routeProjectId?: string,
    authorizedProjectId?: string | { id: string } | null,
    currentUserId?: string,
  ) {
    const isResolved = body.resolved ?? true;
    const { targetProjectId } = await this.loadThreadOrThrow(
      pageId,
      commentId,
      routeProjectId,
      authorizedProjectId,
    );

    await this.reviewScopeRepo.updateThreadInProject(
      targetProjectId,
      commentId,
      { isResolved },
    );

    const {
      thread: updated,
      userMap,
      commentPayload,
    } = await reloadFormattedThread({
      reviewScopeRepo: this.reviewScopeRepo,
      userResolver: this.userResolver,
      projectId: targetProjectId,
      commentId,
      extraUserIds: [currentUserId],
      throwIfMissing: true,
    });

    broadcastReviewProjectEvent(
      this.eventEmitter,
      getRecordSpaceId(updated),
      'comment:resolved',
      {
        docId: updated!.docId,
        commentId: updated!.id,
        resolved: isResolved,
        comment: commentPayload,
      },
    );

    await dispatchCommentResolvedNotification({
      dispatcher: this.notificationDispatcher,
      label: 'resolveComment',
      thread: updated!,
      isResolved,
      actorId: currentUserId,
      fallbackProjectId: targetProjectId,
      userMap,
    });

    return { comment: commentPayload };
  }
}
