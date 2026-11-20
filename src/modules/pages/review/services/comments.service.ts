import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthenticatedRequest, isUuid } from '@/core';
import { getRecordSpaceId } from '@/modules/pages/core/page-scope.helper';
import { PageService } from '@/modules/pages/core/services/page.service';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import {
  ProjectRolePolicy,
  ResourceAccessPolicy,
  Role,
} from '@/modules/project/access';
import { CommentReply, CommentThread, TextRange } from '../domain';
import { REVIEW_EVENTS, emitReviewEvent } from '../review.events';
import { ReviewRepository } from '../review.repository';
import {
  assertCanModifyItem,
  resolveReviewTarget,
  toCommentDto,
  validateCommentLines,
} from './scope.helper';

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    private readonly repo: ReviewRepository,
    private readonly scopeRepo: ScopeRepository,
    private readonly userResolver: UserResolverService,
    private readonly pageService: PageService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  private resolveTarget(
    targetId: string,
    authSpace?: string | { id: string } | null,
  ) {
    return resolveReviewTarget({
      scopeRepo: this.scopeRepo,
      pageService: this.pageService,
      targetId,
      authSpace,
      fallbackPrisma: this.repo.getPrisma(),
    });
  }

  private async loadThreadOrThrow(
    targetId: string,
    commentId: string,
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
  ) {
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }
    const { docId, spaceId: resolvedSpace } = await this.resolveTarget(
      targetId,
      routeSpaceId || authSpace,
    );
    const spaceId =
      resolvedSpace ||
      this.pageService.resolveActiveProjectId(authSpace) ||
      routeSpaceId;
    const thread = spaceId
      ? await this.repo.findThread(spaceId, commentId, docId)
      : null;
    if (!thread) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }
    return { spaceId: spaceId!, thread };
  }

  private async formatReloadedThread(
    spaceId: string,
    commentId: string,
    options?: {
      extraUserIds?: (string | null | undefined)[];
      includeAvatar?: boolean;
      includeDocId?: boolean;
      throwIfMissing?: boolean;
    },
  ) {
    const thread = await this.repo.findThread(spaceId, commentId);
    if (!thread) {
      if (options?.throwIfMissing) {
        throw new NotFoundException(`Comment thread ${commentId} not found`);
      }
      return { thread: null, commentPayload: null };
    }
    const userMap = await this.userResolver.resolveUserNames([
      thread.createdById,
      ...(options?.extraUserIds ?? []),
      ...(thread.replies || []).map((r) => r.createdById),
    ]);
    return {
      thread,
      commentPayload: toCommentDto(thread, userMap, {
        includeAvatar: options?.includeAvatar,
        includeDocId: options?.includeDocId,
      }),
    };
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
    const allowCoordinatorDelete =
      action === 'delete' && role === Role.COORDINATOR;
    if (authorId && !allowCoordinatorDelete) {
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
    assertCanModifyItem(authorId, userId, role, fallbackMessage);
  }

  public async list(
    targetId: string,
    status?: string,
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
  ) {
    if (!isUuid(targetId)) return { comments: [] };
    try {
      const { docId, spaceId: resolvedSpace } = await this.resolveTarget(
        targetId,
        authSpace || routeSpaceId,
      );
      const spaceId =
        resolvedSpace ||
        this.pageService.resolveActiveProjectId(authSpace) ||
        routeSpaceId;
      const docTargetId = docId || targetId;
      if (!spaceId) return { comments: [] };

      const isResolved =
        status === 'resolved' ? true : status === 'open' ? false : undefined;
      const threads = await this.repo.listThreads(
        spaceId,
        docTargetId,
        isResolved,
      );
      const userIds: (string | null | undefined)[] = [];
      for (const t of threads) {
        userIds.push(t.createdById);
        for (const r of t.replies) userIds.push(r.createdById);
      }
      const userMap = await this.userResolver.resolveUserNames(userIds);
      return {
        comments: threads.map((t) =>
          toCommentDto(t, userMap, {
            includeAvatar: true,
            includeDocId: false,
          }),
        ),
      };
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to list comments for ${targetId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { comments: [] };
    }
  }

  public async create(
    targetId: string,
    body: {
      content: string;
      line?: number;
      lineEnd?: number;
      spaceId?: string;
    },
    req: AuthenticatedRequest,
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
  ) {
    const activeSpace =
      this.pageService.resolveActiveProjectId(authSpace) || routeSpaceId;
    const {
      docId,
      spaceId: docSpaceId,
      pageId,
    } = await this.resolveTarget(targetId, activeSpace || body?.spaceId);
    const spaceId =
      docSpaceId ||
      activeSpace ||
      body?.spaceId ||
      (await this.pageService.resolveProjectId(targetId));
    const docTargetId = docId || targetId;
    if (!spaceId || !isUuid(spaceId) || !isUuid(docTargetId)) {
      throw new BadRequestException(
        'Valid pageId and associated project required to create a comment',
      );
    }

    const userId = req?.user?.id || req?.user?.sub || null;
    const userMap = await this.userResolver.resolveUserNames([userId]);
    const resolvedUser = userId ? userMap.get(userId) : undefined;
    const authorName =
      resolvedUser?.name ||
      req?.user?.name ||
      req?.user?.email?.split('@')[0] ||
      'Collaborator';

    const { startLine, endLine } = validateCommentLines(
      body.line,
      body.lineEnd,
    );
    const saved = await this.repo.saveThread(
      CommentThread.create({
        spaceId,
        pageId: pageId ?? null,
        docId: docTargetId,
        quote: body.content,
        range: TextRange.create({ startLine, startCol: 0, endLine, endCol: 0 }),
        createdById: isUuid(userId) ? userId : null,
      }),
    );

    const commentPayload = {
      id: saved.id,
      page: docTargetId,
      projectPageId: docTargetId,
      docId: docTargetId,
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

    emitReviewEvent(this.eventEmitter, spaceId, REVIEW_EVENTS.COMMENT_CREATED, {
      docId: docTargetId,
      comment: commentPayload,
    });

    return { comment: commentPayload };
  }

  public async update(
    targetId: string,
    commentId: string,
    body: {
      content?: string;
      status?: 'open' | 'resolved';
      resolved?: boolean;
    },
    req: AuthenticatedRequest,
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
    role?: Role,
  ) {
    const { thread } = await this.loadThreadOrThrow(
      targetId,
      commentId,
      routeSpaceId,
      authSpace,
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
    const spaceId = getRecordSpaceId(thread);

    await this.repo.updateThread(spaceId, commentId, { quote, isResolved });
    const { thread: updated, commentPayload } = await this.formatReloadedThread(
      spaceId,
      commentId,
      {
        throwIfMissing: true,
      },
    );

    emitReviewEvent(
      this.eventEmitter,
      getRecordSpaceId(updated),
      REVIEW_EVENTS.COMMENT_UPDATED,
      { docId: updated!.docId, comment: commentPayload },
    );

    return { comment: commentPayload };
  }

  public async remove(
    targetId: string,
    commentId: string,
    req: AuthenticatedRequest,
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
    role?: Role,
  ) {
    const { thread: existing } = await this.loadThreadOrThrow(
      targetId,
      commentId,
      routeSpaceId,
      authSpace,
    );

    this.assertAuthorOrPolicy(
      req,
      role,
      commentId,
      existing.createdById,
      'delete',
      'Only the comment author or a coordinator/owner can delete this comment',
    );

    const spaceId = getRecordSpaceId(existing);
    await this.repo.deleteThread(spaceId, commentId);
    emitReviewEvent(this.eventEmitter, spaceId, REVIEW_EVENTS.COMMENT_DELETED, {
      docId: existing.docId,
      commentId,
    });
    return { success: true };
  }

  public async resolve(
    targetId: string,
    commentId: string,
    body: { resolved?: boolean },
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
    currentUserId?: string,
  ) {
    const isResolved = body.resolved ?? true;
    const { spaceId } = await this.loadThreadOrThrow(
      targetId,
      commentId,
      routeSpaceId,
      authSpace,
    );

    await this.repo.updateThread(spaceId, commentId, { isResolved });
    const { thread: updated, commentPayload } = await this.formatReloadedThread(
      spaceId,
      commentId,
      {
        extraUserIds: [currentUserId],
        throwIfMissing: true,
      },
    );

    emitReviewEvent(
      this.eventEmitter,
      getRecordSpaceId(updated),
      REVIEW_EVENTS.COMMENT_RESOLVED,
      {
        docId: updated!.docId,
        commentId: updated!.id,
        resolved: isResolved,
        comment: commentPayload,
      },
    );

    return { comment: commentPayload };
  }

  public async addReply(
    targetId: string,
    commentId: string,
    body: { content: string },
    req: AuthenticatedRequest,
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
  ) {
    const { docId, spaceId } = await this.resolveTarget(
      targetId,
      routeSpaceId || authSpace,
    );
    const userId = req?.user?.id || req?.user?.sub || null;
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }
    if (!spaceId) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }

    const thread = await this.repo.findThread(spaceId, commentId, docId);
    if (!thread) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }
    if (thread.isResolved) {
      throw new BadRequestException(
        'Cannot add reply to a resolved comment thread',
      );
    }

    const reply = CommentReply.create({
      threadId: commentId,
      content: body.content,
      createdById: isUuid(userId) ? userId : null,
    });
    await this.repo.addReply(commentId, reply);

    const { thread: updated, commentPayload } = await this.formatReloadedThread(
      spaceId,
      commentId,
      {
        throwIfMissing: true,
      },
    );

    emitReviewEvent(
      this.eventEmitter,
      getRecordSpaceId(updated),
      REVIEW_EVENTS.REPLY_ADDED,
      {
        docId: updated!.docId,
        commentId: updated!.id,
        comment: commentPayload,
      },
    );

    return { comment: commentPayload };
  }

  public async updateReply(
    targetId: string,
    commentId: string,
    replyId: string,
    body: { content: string },
    routeSpaceId?: string,
    req?: AuthenticatedRequest,
    authSpace?: string | { id: string } | null,
    role?: Role,
  ) {
    if (!isUuid(replyId) || !isUuid(commentId)) {
      throw new BadRequestException(
        'Valid UUIDs are required for commentId and replyId',
      );
    }
    const trimmed =
      typeof body?.content === 'string' ? body.content.trim() : '';
    if (!trimmed || trimmed.length > 10000) {
      throw new BadRequestException(
        'Reply content must be between 1 and 10000 characters',
      );
    }

    const { docId, spaceId } = await this.resolveTarget(
      targetId,
      routeSpaceId || authSpace,
    );
    if (!spaceId) {
      throw new NotFoundException(`Reply ${replyId} not found`);
    }

    const thread = await this.repo.findThread(spaceId, commentId, docId);
    const reply = thread?.replies?.find((r) => r.id === replyId);
    if (!thread || !reply) {
      throw new NotFoundException(`Reply ${replyId} not found`);
    }
    if (thread.isResolved) {
      throw new ConflictException({
        statusCode: 409,
        code: 'COMMENT_THREAD_RESOLVED',
        message: 'Cannot edit reply in a resolved comment thread',
      });
    }

    if (reply.createdById) {
      const userId = req?.user?.id || req?.user?.sub;
      const reqCtx = req as
        { projectMember?: { permissionBitmask?: string } } | undefined;
      new ResourceAccessPolicy().assertCanModifyComment(
        {
          userId: userId ?? '',
          role: role ?? Role.REVIEWER,
          permissionBitmask: reqCtx?.projectMember?.permissionBitmask,
        },
        { id: replyId, authorId: reply.createdById },
        'update',
      );
    }

    await this.repo.updateReply(thread.id, replyId, trimmed);

    const { commentPayload } = await this.formatReloadedThread(
      spaceId,
      commentId,
      { includeAvatar: true, includeDocId: false },
    );

    emitReviewEvent(this.eventEmitter, spaceId, REVIEW_EVENTS.REPLY_UPDATED, {
      docId: thread.docId,
      commentId: thread.id,
      replyId,
      comment: commentPayload,
    });

    return { comment: commentPayload };
  }

  public async deleteReply(
    targetId: string,
    commentId: string,
    replyId: string,
    routeSpaceId?: string,
    req?: AuthenticatedRequest,
    authSpace?: string | { id: string } | null,
    role?: Role,
  ) {
    if (!isUuid(replyId) || !isUuid(commentId)) {
      throw new BadRequestException(
        'Valid UUIDs are required for commentId and replyId',
      );
    }

    const { docId, spaceId } = await this.resolveTarget(
      targetId,
      routeSpaceId || authSpace,
    );
    if (!spaceId) {
      throw new NotFoundException(`Reply ${replyId} not found`);
    }

    const thread = await this.repo.findThread(spaceId, commentId, docId);
    const reply = thread?.replies?.find((r) => r.id === replyId);
    if (!thread || !reply) {
      throw new NotFoundException(`Reply ${replyId} not found`);
    }

    const userId = req?.user?.id || req?.user?.sub;
    if (userId || role) {
      this.assertAuthorOrPolicy(
        req,
        role,
        replyId,
        reply.createdById,
        'delete',
        'Only the reply author or a coordinator/owner can delete this reply',
      );
    }

    await this.repo.deleteReply(thread.id, replyId).catch(() => false);

    emitReviewEvent(this.eventEmitter, spaceId, REVIEW_EVENTS.REPLY_DELETED, {
      docId: thread.docId,
      commentId: thread.id,
      replyId,
    });

    const { commentPayload } = await this.formatReloadedThread(
      spaceId,
      commentId,
      { includeAvatar: true, includeDocId: false },
    );

    return { success: true, comment: commentPayload };
  }
}
