/**
 * modules/manuscripts/docstore/controllers/pages-review.controller.ts
 * Domain-focused controller handling Inline Comments, Comment Threads,
 * and Track-Change Suggestions routes.
 * Delegates review persistence and logic to TrackChangesService, DocstoreService,
 * and ManuscriptPageScopeRepository without raw Prisma queries.
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  HttpStatus,
  HttpCode,
  Optional,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedProject,
  CurrentRole,
} from '@/modules/project/access';
import { ManuscriptChangeType } from '@prisma/client';
import { UpdateReviewStatusDto } from '../dto/review-status.dto';
import { AuthenticatedRequest, isUuid } from '@/core';
import { ModuleRef } from '@nestjs/core';
import { DocstoreService } from '../docstore.service';
import { ManuscriptPageService } from '@/modules/manuscripts/core/services/manuscript-page.service';
import { ManuscriptUserResolverService } from '@/modules/manuscripts/core/services/manuscript-user-resolver.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LiveCollaborationPort } from '@/modules/manuscripts/core';
import { ManuscriptPageScopeRepository } from '../repositories/manuscript-page-scope.repository';
import { TrackChangesService } from '@/modules/manuscripts/track-changes/track-changes.service';
import { TrackChangesRepository } from '@/modules/manuscripts/track-changes/track-changes.repository';
import {
  CommentThread,
  CommentReply,
  TrackChange,
  TextRangeVo,
} from '@/modules/manuscripts/track-changes/domain';
import {
  validateCommentRange,
  validateSuggestionRange,
  assertCanModifyReviewItem,
  formatCommentThreadDto,
  formatSuggestionItemDto,
  getDocReviewStatusWithFallback,
  updateDocReviewStatusWithCas,
} from './pages-review.helpers';

export interface CreateSuggestionBody {
  type?: string;
  suggestedText?: string;
  originalText?: string;
  fromLine?: number;
  fromColumn?: number;
  toLine?: number;
  toColumn?: number;
  projectId?: string;
  [key: string]: unknown;
}

@ApiTags('Manuscripts - Pages Review & Comments')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/manuscripts')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class PagesReviewController {
  private readonly logger = new Logger(PagesReviewController.name);
  private liveCollab: LiveCollaborationPort | null | undefined;

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly pageScopeRepo: ManuscriptPageScopeRepository,
    private readonly userResolver: ManuscriptUserResolverService,
    private readonly pageService: ManuscriptPageService,
    @Optional()
    private readonly trackChangesService?: TrackChangesService,
    @Optional()
    private readonly trackChangesRepo?: TrackChangesRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  private broadcastEvent(
    projectId: string | null | undefined,
    event: string,
    payload: unknown,
  ): void {
    if (!projectId || !this.eventEmitter) return;
    try {
      this.eventEmitter.emit('manuscripts.project.event', {
        projectId,
        event,
        payload,
      });
    } catch {
      // Non-blocking real-time broadcast error ignored
    }
  }

  private getLiveCollaboration(): LiveCollaborationPort | null {
    if (this.liveCollab !== undefined) return this.liveCollab;
    try {
      this.liveCollab =
        this.moduleRef?.get(LiveCollaborationPort, { strict: false }) ?? null;
    } catch {
      this.liveCollab = null;
    }
    return this.liveCollab;
  }

  private async syncLiveDoc(
    projectId: string,
    docId: string,
    lines: string[],
  ): Promise<boolean> {
    const live = this.getLiveCollaboration();
    if (!live) return false;
    try {
      return await live.applyExternalText(projectId, docId, lines.join('\n'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to sync REST write into live session ${projectId}:${docId}: ${message}`,
      );
      return false;
    }
  }

  private async resolveUserNames(
    userIds: (string | null | undefined)[],
  ): Promise<Map<string, { id: string; name: string; avatar?: string }>> {
    return this.userResolver.resolveUserNames(userIds);
  }

  private resolveActiveProjectId(
    project?: string | { id: string } | null,
  ): string | undefined {
    return this.pageService.resolveActiveProjectId(project);
  }

  private async resolveDocAndProject(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ): Promise<{ docId?: string; projectId?: string }> {
    const activeProjectId = this.resolveActiveProjectId(authorizedProjectId);
    if (!isUuid(pageId)) {
      return { projectId: activeProjectId };
    }
    const doc = activeProjectId
      ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
      : null;
    if (doc) {
      return { docId: doc.id, projectId: doc.projectId || activeProjectId };
    }
    const resolvedProj = await this.pageService.resolveProjectId(pageId);
    return { docId: pageId, projectId: resolvedProj || activeProjectId };
  }

  // ─── 1. INLINE COMMENTS & THREADS ─────────────────────────────────────────────

  /**
   * GET /api/v1/manuscripts/pages/:pageId/comments
   * GET /api/v1/manuscripts/docs/:pageId/comments
   * GET /api/v1/manuscripts/projects/:projectId/docs/:pageId/comments
   */
  @Get([
    'pages/:pageId/comments',
    'docs/:pageId/comments',
    'projects/:projectId/docs/:pageId/comments',
  ])
  async getComments(
    @Param('pageId') pageId: string,
    @Query('status') status?: string,
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) return { comments: [] };
    try {
      const targetProjectId =
        this.resolveActiveProjectId(authorizedProjectId) || routeProjectId;
      if (!targetProjectId || !this.trackChangesRepo) return { comments: [] };

      const isResolved =
        status === 'resolved' ? true : status === 'open' ? false : undefined;
      const domainThreads = await this.trackChangesRepo.listThreadsByDoc(
        targetProjectId,
        pageId,
        isResolved,
      );

      const userIds: (string | null | undefined)[] = [];
      for (const t of domainThreads) {
        userIds.push(t.createdById);
        for (const r of t.replies || []) {
          userIds.push(r.createdById);
        }
      }
      const userMap = await this.resolveUserNames(userIds);

      const comments = domainThreads.map((t) => {
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
            const replyUser = r.createdById
              ? userMap.get(r.createdById)
              : undefined;
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
      });

      return { comments };
    } catch {
      return { comments: [] };
    }
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/comments
   * POST /api/v1/manuscripts/docs/:pageId/comments
   * POST /api/v1/manuscripts/projects/:projectId/docs/:pageId/comments
   */
  @Post([
    'pages/:pageId/comments',
    'docs/:pageId/comments',
    'projects/:projectId/docs/:pageId/comments',
  ])
  @HttpCode(HttpStatus.CREATED)
  async createComment(
    @Param('pageId') pageId: string,
    @Body()
    body: {
      content: string;
      line?: number;
      lineEnd?: number;
      projectId?: string;
    },
    @Req() req: AuthenticatedRequest,
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    const activeProj =
      this.resolveActiveProjectId(authorizedProjectId) || routeProjectId;
    const resolvedProj =
      activeProj ||
      body?.projectId ||
      (await this.pageService.resolveProjectId(pageId));
    if (!resolvedProj || !isUuid(resolvedProj)) {
      throw new BadRequestException(
        'Valid pageId and associated project required to create a comment',
      );
    }

    const userMap = await this.resolveUserNames([userId]);
    const resolvedUser = userId ? userMap.get(userId) : undefined;
    const authorName =
      resolvedUser?.name ||
      req?.user?.name ||
      req?.user?.email?.split('@')[0] ||
      'Collaborator';

    const { startLine, endLine } = validateCommentRange(
      body.line,
      body.lineEnd,
    );

    const threadEntity = CommentThread.create({
      projectId: resolvedProj,
      docId: pageId,
      quote: body.content,
      range: TextRangeVo.create({
        startLine,
        startCol: 0,
        endLine,
        endCol: 0,
      }),
      createdById: isUuid(userId) ? userId : null,
    });

    if (!this.trackChangesRepo) {
      throw new BadRequestException('TrackChanges repository not available');
    }

    const saved = await this.trackChangesRepo.saveCommentThread(threadEntity);

    const commentPayload = {
      id: saved.id,
      page: pageId,
      projectPageId: pageId,
      docId: pageId,
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

    this.broadcastEvent(resolvedProj, 'comment:created', {
      docId: pageId,
      comment: commentPayload,
    });

    return { comment: commentPayload };
  }

  /**
   * PATCH /api/v1/manuscripts/pages/:pageId/comments/:commentId
   * PATCH /api/v1/manuscripts/docs/:pageId/comments/:commentId
   * PATCH /api/v1/manuscripts/projects/:projectId/docs/:pageId/comments/:commentId
   */
  @Patch([
    'pages/:pageId/comments/:commentId',
    'docs/:pageId/comments/:commentId',
    'projects/:projectId/docs/:pageId/comments/:commentId',
  ])
  async updateComment(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Body()
    body: {
      content?: string;
      status?: 'open' | 'resolved';
      resolved?: boolean;
    },
    @Req() req: AuthenticatedRequest,
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    const userId = req?.user?.id || req?.user?.sub;
    const targetProjectId =
      this.resolveActiveProjectId(authorizedProjectId) || routeProjectId;

    const thread = targetProjectId
      ? await this.pageScopeRepo.findThreadInProject(
          targetProjectId,
          commentId,
          isUuid(pageId) ? pageId : undefined,
        )
      : null;

    if (!thread) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }

    assertCanModifyReviewItem(
      thread.createdById,
      userId,
      role,
      'Only the comment author or a coordinator/owner can edit this comment',
    );

    let isResolved = thread.isResolved;
    if (body.resolved !== undefined) {
      isResolved = Boolean(body.resolved);
    } else if (body.status !== undefined) {
      isResolved = body.status === 'resolved';
    }
    const quote = body.content !== undefined ? body.content : thread.quote;

    await this.pageScopeRepo.updateThreadInProject(thread.projectId, commentId, {
      quote,
      isResolved,
    });

    const updated = await this.pageScopeRepo.findThreadInProject(
      thread.projectId,
      commentId,
    );
    if (!updated) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }

    const userMap = await this.resolveUserNames([
      updated.createdById,
      ...(updated.replies || []).map((r) => r.createdById),
    ]);
    const commentPayload = formatCommentThreadDto(updated, userMap);

    this.broadcastEvent(updated.projectId, 'comment:updated', {
      docId: updated.docId,
      comment: commentPayload,
    });

    return { comment: commentPayload };
  }

  /**
   * DELETE /api/v1/manuscripts/pages/:pageId/comments/:commentId
   * DELETE /api/v1/manuscripts/docs/:pageId/comments/:commentId
   * DELETE /api/v1/manuscripts/projects/:projectId/docs/:pageId/comments/:commentId
   */
  @Delete([
    'pages/:pageId/comments/:commentId',
    'docs/:pageId/comments/:commentId',
    'projects/:projectId/docs/:pageId/comments/:commentId',
  ])
  @HttpCode(HttpStatus.OK)
  async deleteComment(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Req() req: AuthenticatedRequest,
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    const userId = req?.user?.id || req?.user?.sub;
    const targetProjectId =
      this.resolveActiveProjectId(authorizedProjectId) || routeProjectId;

    const existing = targetProjectId
      ? await this.pageScopeRepo.findThreadInProject(
          targetProjectId,
          commentId,
          isUuid(pageId) ? pageId : undefined,
        )
      : null;

    if (!existing) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }

    assertCanModifyReviewItem(
      existing.createdById,
      userId,
      role,
      'Only the comment author or a coordinator/owner can delete this comment',
    );

    await this.pageScopeRepo.deleteThreadInProject(
      existing.projectId,
      commentId,
    );

    this.broadcastEvent(existing.projectId, 'comment:deleted', {
      docId: existing.docId,
      commentId,
    });

    return { success: true };
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/comments/:commentId/reply
   * POST /api/v1/manuscripts/pages/:pageId/comments/:commentId/replies
   * POST /api/v1/manuscripts/docs/:pageId/comments/:commentId/reply
   * POST /api/v1/manuscripts/docs/:pageId/comments/:commentId/replies
   * POST /api/v1/manuscripts/projects/:projectId/docs/:pageId/comments/:commentId/reply
   * POST /api/v1/manuscripts/projects/:projectId/docs/:pageId/comments/:commentId/replies
   */
  @Post([
    'pages/:pageId/comments/:commentId/reply',
    'pages/:pageId/comments/:commentId/replies',
    'docs/:pageId/comments/:commentId/reply',
    'docs/:pageId/comments/:commentId/replies',
    'projects/:projectId/docs/:pageId/comments/:commentId/reply',
    'projects/:projectId/docs/:pageId/comments/:commentId/replies',
  ])
  @HttpCode(HttpStatus.CREATED)
  async addCommentReply(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Body() body: { content: string },
    @Req() req: AuthenticatedRequest,
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDocAndProject(
        pageId,
        routeProjectId || authorizedProjectId,
      );

    if (!targetProjectId || !this.trackChangesRepo) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }

    const existingThread = await this.pageScopeRepo.findThreadInProject(
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

    await this.trackChangesRepo.addCommentReply(commentId, replyEntity);

    const thread = await this.pageScopeRepo.findThreadInProject(
      targetProjectId,
      commentId,
    );

    if (!thread) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }

    const userMap = await this.resolveUserNames([
      thread.createdById,
      ...(thread.replies || []).map((r) => r.createdById),
    ]);
    const commentPayload = formatCommentThreadDto(thread, userMap);

    this.broadcastEvent(thread.projectId, 'comment:reply-added', {
      docId: thread.docId,
      commentId: thread.id,
      comment: commentPayload,
    });

    return { comment: commentPayload };
  }

  /**
   * DELETE /api/v1/manuscripts/pages/:pageId/comments/:commentId/replies/:replyId
   * DELETE /api/v1/manuscripts/docs/:pageId/comments/:commentId/replies/:replyId
   */
  @Delete([
    'pages/:pageId/comments/:commentId/replies/:replyId',
    'docs/:pageId/comments/:commentId/replies/:replyId',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async deleteCommentReply(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    if (!isUuid(replyId) || !isUuid(commentId)) {
      throw new BadRequestException(
        'Valid UUIDs are required for commentId and replyId',
      );
    }

    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDocAndProject(pageId, authorizedProjectId);
    const userId = req?.user?.id || req?.user?.sub;

    if (!targetProjectId) {
      throw new NotFoundException(`Reply ${replyId} not found`);
    }

    const existingThread = await this.pageScopeRepo.findThreadInProject(
      targetProjectId,
      commentId,
      resolvedDocId,
    );
    const existingReply = existingThread?.replies?.find((r) => r.id === replyId);

    if (!existingThread || !existingReply) {
      throw new NotFoundException(`Reply ${replyId} not found`);
    }

    if (userId || role) {
      const isReplyAuthor = existingReply.createdById === userId;
      const isPrivileged = role === Role.COORDINATOR || role === Role.OWNER;
      if (
        existingReply.createdById &&
        userId &&
        !isReplyAuthor &&
        !isPrivileged
      ) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'ROLE_INSUFFICIENT',
          message:
            'Only the reply author or a coordinator/owner can delete this reply',
        });
      }
    }

    await this.pageScopeRepo
      .deleteReplyInThread(existingThread.id, replyId)
      .catch(() => false);

    this.broadcastEvent(targetProjectId, 'comment:reply-deleted', {
      docId: existingThread.docId,
      commentId: existingThread.id,
      replyId,
    });

    let commentPayload = null;
    const updatedThread = await this.pageScopeRepo.findThreadInProject(
      targetProjectId,
      commentId,
    );
    if (updatedThread) {
      const userMap = await this.resolveUserNames([
        updatedThread.createdById,
        ...(updatedThread.replies || []).map((r) => r.createdById),
      ]);
      commentPayload = formatCommentThreadDto(updatedThread, userMap, {
        includeAvatar: true,
        includeDocId: false,
      });
    }

    return { success: true, comment: commentPayload };
  }

  /**
   * PATCH /api/v1/manuscripts/pages/:pageId/comments/:commentId/resolve
   * PATCH /api/v1/manuscripts/docs/:pageId/comments/:commentId/resolve
   * PATCH /api/v1/manuscripts/projects/:projectId/docs/:pageId/comments/:commentId/resolve
   */
  @Patch([
    'pages/:pageId/comments/:commentId/resolve',
    'docs/:pageId/comments/:commentId/resolve',
    'projects/:projectId/docs/:pageId/comments/:commentId/resolve',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  async resolveComment(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Body() body: { resolved?: boolean },
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    const isResolved = body.resolved ?? true;
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDocAndProject(
        pageId,
        routeProjectId || authorizedProjectId,
      );

    if (!targetProjectId) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }

    const thread = await this.pageScopeRepo.findThreadInProject(
      targetProjectId,
      commentId,
      resolvedDocId,
    );
    if (!thread) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }

    await this.pageScopeRepo.updateThreadInProject(targetProjectId, commentId, {
      isResolved,
    });

    const updated = await this.pageScopeRepo.findThreadInProject(
      targetProjectId,
      commentId,
    );
    if (!updated) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }

    const userMap = await this.resolveUserNames([
      updated.createdById,
      ...(updated.replies || []).map((r) => r.createdById),
    ]);
    const commentPayload = formatCommentThreadDto(updated, userMap);

    this.broadcastEvent(updated.projectId, 'comment:resolved', {
      docId: updated.docId,
      commentId: updated.id,
      resolved: isResolved,
      comment: commentPayload,
    });

    return { comment: commentPayload };
  }

  // ─── 2. TRACK CHANGES / REVIEW SUGGESTIONS ───────────────────────────────────

  /**
   * GET /api/v1/manuscripts/pages/:pageId/suggestions
   * GET /api/v1/manuscripts/docs/:pageId/suggestions
   * GET /api/v1/manuscripts/projects/:projectId/docs/:pageId/suggestions
   */
  @Get([
    'pages/:pageId/suggestions',
    'docs/:pageId/suggestions',
    'projects/:projectId/docs/:pageId/suggestions',
  ])
  async getSuggestions(
    @Param('pageId') pageId: string,
    @Query('status') status?: 'pending' | 'accepted' | 'rejected',
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) return { suggestions: [] };
    try {
      const targetProjectId =
        this.resolveActiveProjectId(authorizedProjectId) || routeProjectId;
      if (!targetProjectId || !this.trackChangesRepo) {
        return { suggestions: [] };
      }

      const domainChanges = await this.trackChangesRepo.listChangesByDoc(
        targetProjectId,
        pageId,
        status,
      );

      const userMap = await this.resolveUserNames(
        domainChanges.map((s) => s.createdById),
      );

      const suggestions = domainChanges.map((s) => {
        const creator = s.createdById ? userMap.get(s.createdById) : undefined;
        return {
          id: s.id,
          pageId: s.docId,
          page: s.docId,
          projectPageId: s.docId,
          authorId: s.createdById || 'anonymous',
          author: {
            id: s.createdById || 'anonymous',
            name: creator?.name || 'Collaborator',
            avatar: creator?.avatar,
            email: '',
          },
          type: s.type,
          originalText: s.type === 'delete' ? s.text : '',
          suggestedText: s.type === 'insert' ? s.text : '',
          text: s.text,
          fromLine: s.range.startLine,
          fromColumn: s.range.startCol,
          toLine: s.range.endLine,
          toColumn: s.range.endCol,
          status: s.status,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          resolvedAt: s.resolvedAt ? s.resolvedAt.toISOString() : null,
          resolvedBy: s.resolvedById ? { id: s.resolvedById } : null,
          resolvedById: s.resolvedById,
        };
      });

      return { suggestions };
    } catch {
      return { suggestions: [] };
    }
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/suggestions
   * POST /api/v1/manuscripts/docs/:pageId/suggestions
   * POST /api/v1/manuscripts/projects/:projectId/docs/:pageId/suggestions
   */
  @Post([
    'pages/:pageId/suggestions',
    'docs/:pageId/suggestions',
    'projects/:projectId/docs/:pageId/suggestions',
  ])
  @HttpCode(HttpStatus.CREATED)
  async createSuggestion(
    @Param('pageId') pageId: string,
    @Body() body: CreateSuggestionBody,
    @Req() req: AuthenticatedRequest,
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    const activeProj =
      this.resolveActiveProjectId(authorizedProjectId) || routeProjectId;
    const resolvedProj =
      activeProj ||
      body?.projectId ||
      (await this.pageService.resolveProjectId(pageId));
    if (!resolvedProj || !isUuid(resolvedProj)) {
      throw new BadRequestException(
        'Valid pageId and associated project required to create a suggestion',
      );
    }

    const type: ManuscriptChangeType =
      body.type === 'delete'
        ? ManuscriptChangeType.delete
        : ManuscriptChangeType.insert;
    const text = body.suggestedText || body.originalText || '';

    const userMap = await this.resolveUserNames([userId]);
    const resolvedUser = userId ? userMap.get(userId) : undefined;
    const authorName =
      resolvedUser?.name ||
      req?.user?.name ||
      req?.user?.email?.split('@')[0] ||
      'Collaborator';
    const authorEmail = req?.user?.email || '';

    const { startLine, endLine, startCol, endCol } =
      validateSuggestionRange(body);

    const changeEntity = TrackChange.create({
      projectId: resolvedProj,
      docId: pageId,
      type: body.type === 'delete' ? 'delete' : 'insert',
      text,
      range: TextRangeVo.create({
        startLine,
        startCol,
        endLine,
        endCol,
      }),
      createdById: isUuid(userId) ? userId : null,
    });

    if (!this.trackChangesRepo) {
      throw new BadRequestException('TrackChanges repository not available');
    }

    const saved = await this.trackChangesRepo.saveChange(changeEntity);

    const suggestionPayload = {
      id: saved.id,
      pageId,
      page: pageId,
      projectPageId: pageId,
      authorId: userId || saved.createdById || 'anonymous',
      author: {
        id: userId || saved.createdById || 'anonymous',
        name: authorName,
        email: authorEmail,
      },
      type: saved.type,
      originalText: saved.type === 'delete' ? saved.text : '',
      suggestedText: saved.type === 'insert' ? saved.text : '',
      text: saved.text,
      fromLine: saved.range.startLine,
      fromColumn: saved.range.startCol,
      toLine: saved.range.endLine,
      toColumn: saved.range.endCol,
      status: saved.status,
      createdAt: saved.createdAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
    };

    this.broadcastEvent(resolvedProj, 'track-changes:created', {
      docId: pageId,
      suggestion: suggestionPayload,
    });

    return { suggestion: suggestionPayload };
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/suggestions/:suggestionId/accept
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/:suggestionId/accept
   * POST /api/v1/manuscripts/projects/:projectId/docs/:pageId/suggestions/:suggestionId/accept
   */
  @Post([
    'pages/:pageId/suggestions/:suggestionId/accept',
    'docs/:pageId/suggestions/:suggestionId/accept',
    'projects/:projectId/docs/:pageId/suggestions/:suggestionId/accept',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async acceptSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
    @CurrentUser('id') userId?: string,
  ) {
    if (!isUuid(suggestionId)) {
      throw new BadRequestException(
        'A valid UUID is required for suggestionId',
      );
    }

    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDocAndProject(
        pageId,
        routeProjectId || authorizedProjectId,
      );

    if (!targetProjectId || !this.trackChangesRepo) {
      throw new NotFoundException(`Suggestion ${suggestionId} not found`);
    }

    const existing = await this.pageScopeRepo.findTrackChangeInProject(
      targetProjectId,
      suggestionId,
      resolvedDocId,
    );

    if (!existing) {
      throw new NotFoundException(`Suggestion ${suggestionId} not found`);
    }

    if (existing.status !== 'pending') {
      const userMap = await this.resolveUserNames([existing.createdById, userId]);
      const formatted = formatSuggestionItemDto(existing, userMap);
      return { ok: true, suggestion: { ...existing, ...formatted } };
    }

    await this.pageScopeRepo.updateTrackChangeInProject(
      targetProjectId,
      suggestionId,
      {
        status: 'accepted',
        resolvedAt: new Date(),
        resolvedById: isUuid(userId) ? userId : null,
      },
    );

    const record = await this.pageScopeRepo.findTrackChangeInProject(
      targetProjectId,
      suggestionId,
    );

    let updatedPage: {
      id: string;
      content: string;
      version: number;
      rev: number;
      projectId: string;
    } | null = null;

    if (record && record.docId) {
      try {
        const live = this.getLiveCollaboration();
        if (live && targetProjectId) {
          await live.flushDocs(targetProjectId, [record.docId]).catch(() => []);
        }

        const doc = await this.pageScopeRepo.findDocInProject(
          targetProjectId,
          record.docId,
        );
        if (doc) {
          const lines = await this.pageService.getHydratedDocLines(doc);
          const { LinePatcher } = await import(
            '@/modules/manuscripts/track-changes/domain'
          );
          const changeEntity = TrackChange.create({
            id: record.id,
            projectId: doc.projectId,
            docId: doc.id,
            type: record.type === 'delete' ? 'delete' : 'insert',
            text: record.text,
            range: TextRangeVo.create({
              startLine: Math.max(0, (record.startLine ?? 1) > 0 ? (record.startLine ?? 1) - 1 : 0),
              startCol: Math.max(0, record.startCol ?? 0),
              endLine: Math.max(0, (record.endLine ?? record.startLine ?? 1) > 0 ? (record.endLine ?? record.startLine ?? 1) - 1 : 0),
              endCol: Math.max(0, record.endCol ?? 0),
            }),
            createdById: record.createdById,
          });
          const { lines: nextLines, mutated } =
            LinePatcher.computeAcceptedPatch(lines, changeEntity);

          let finalVersion = doc.version;
          let finalRev = doc.rev;
          if (mutated) {
            const updateRes = await this.docstoreService.updateDoc(doc.projectId, doc.id, {
              lines: nextLines,
              version: doc.version + 1,
              expectedRev: doc.rev,
            });
            finalVersion = updateRes?.doc?.version ?? doc.version + 1;
            finalRev = updateRes?.rev ?? updateRes?.doc?.rev ?? doc.rev + 1;

            await this.syncLiveDoc(doc.projectId, doc.id, nextLines);
          }

          updatedPage = {
            id: doc.id,
            content: nextLines.join('\n'),
            version: finalVersion,
            rev: finalRev,
            projectId: doc.projectId,
          };

          this.broadcastEvent(doc.projectId, 'track-changes:resolved', {
            docId: doc.id,
            change: record,
            action: 'accepted',
            resolvedById: isUuid(userId) ? userId : null,
          });
        }
      } catch (applyErr) {
        this.logger.error(
          `Failed to apply accepted suggestion ${suggestionId} to docstore, rolling back status: ${applyErr}`,
        );
        await this.pageScopeRepo.updateTrackChangeInProject(
          targetProjectId,
          suggestionId,
          { status: 'pending', resolvedAt: null, resolvedById: null },
        );
        throw applyErr;
      }
    }

    const userMap = await this.resolveUserNames([record?.createdById, userId]);
    const formatted = record ? formatSuggestionItemDto(record, userMap) : null;
    return {
      ok: true,
      suggestion: record ? { ...record, ...formatted } : null,
      ...(updatedPage ? { page: updatedPage } : {}),
    };
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/suggestions/:suggestionId/reject
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/:suggestionId/reject
   * POST /api/v1/manuscripts/projects/:projectId/docs/:pageId/suggestions/:suggestionId/reject
   */
  @Post([
    'pages/:pageId/suggestions/:suggestionId/reject',
    'docs/:pageId/suggestions/:suggestionId/reject',
    'projects/:projectId/docs/:pageId/suggestions/:suggestionId/reject',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async rejectSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
    @CurrentUser('id') userId?: string,
  ) {
    if (!isUuid(suggestionId)) {
      throw new BadRequestException(
        'A valid UUID is required for suggestionId',
      );
    }

    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDocAndProject(
        pageId,
        routeProjectId || authorizedProjectId,
      );

    if (!targetProjectId) {
      throw new NotFoundException(`Suggestion ${suggestionId} not found`);
    }

    const existing = await this.pageScopeRepo.findTrackChangeInProject(
      targetProjectId,
      suggestionId,
      resolvedDocId,
    );

    if (!existing) {
      throw new NotFoundException(`Suggestion ${suggestionId} not found`);
    }

    if (existing.status && existing.status !== 'pending') {
      const userMap = await this.resolveUserNames([existing.createdById, userId]);
      const formatted = formatSuggestionItemDto(existing, userMap);
      return { ok: true, suggestion: { ...existing, ...formatted } };
    }

    await this.pageScopeRepo.updateTrackChangeInProject(
      targetProjectId,
      suggestionId,
      {
        status: 'rejected',
        resolvedAt: new Date(),
        resolvedById: isUuid(userId) ? userId : null,
      },
    );

    const record = await this.pageScopeRepo.findTrackChangeInProject(
      targetProjectId,
      suggestionId,
    );

    let updatedPage: {
      id: string;
      content: string;
      version: number;
      rev: number;
      projectId: string;
    } | null = null;

    if (record && record.docId) {
      try {
        const live = this.getLiveCollaboration();
        if (live && targetProjectId) {
          await live.flushDocs(targetProjectId, [record.docId]).catch(() => []);
        }

        const doc = await this.pageScopeRepo.findDocInProject(
          targetProjectId,
          record.docId,
        );
        if (doc) {
          const lines = await this.pageService.getHydratedDocLines(doc);
          const { LinePatcher } = await import(
            '@/modules/manuscripts/track-changes/domain'
          );
          const changeEntity = TrackChange.create({
            id: record.id,
            projectId: doc.projectId,
            docId: doc.id,
            type: record.type === 'delete' ? 'delete' : 'insert',
            text: record.text,
            range: TextRangeVo.create({
              startLine: Math.max(0, (record.startLine ?? 1) > 0 ? (record.startLine ?? 1) - 1 : 0),
              startCol: Math.max(0, record.startCol ?? 0),
              endLine: Math.max(0, (record.endLine ?? record.startLine ?? 1) > 0 ? (record.endLine ?? record.startLine ?? 1) - 1 : 0),
              endCol: Math.max(0, record.endCol ?? 0),
            }),
            createdById: record.createdById,
          });
          const { lines: nextLines, mutated } =
            LinePatcher.computeRejectedPatch(lines, changeEntity);

          let finalVersion = doc.version;
          let finalRev = doc.rev;
          if (mutated) {
            const updateRes = await this.docstoreService.updateDoc(doc.projectId, doc.id, {
              lines: nextLines,
              version: doc.version + 1,
              expectedRev: doc.rev,
            });
            finalVersion = updateRes?.doc?.version ?? doc.version + 1;
            finalRev = updateRes?.rev ?? updateRes?.doc?.rev ?? doc.rev + 1;

            await this.syncLiveDoc(doc.projectId, doc.id, nextLines);
          }

          updatedPage = {
            id: doc.id,
            content: nextLines.join('\n'),
            version: finalVersion,
            rev: finalRev,
            projectId: doc.projectId,
          };
        }
      } catch (revertErr) {
        this.logger.error(
          `Failed to revert rejected suggestion ${suggestionId} in docstore, rolling back status: ${revertErr}`,
        );
        await this.pageScopeRepo.updateTrackChangeInProject(
          targetProjectId,
          suggestionId,
          { status: 'pending', resolvedAt: null, resolvedById: null },
        );
        throw revertErr;
      }

      this.broadcastEvent(targetProjectId, 'track-changes:resolved', {
        docId: record.docId,
        change: record,
        action: 'rejected',
        resolvedById: isUuid(userId) ? userId : null,
      });
    }

    const userMap = await this.resolveUserNames([record?.createdById, userId]);
    const formatted = record ? formatSuggestionItemDto(record, userMap) : null;
    return {
      ok: true,
      suggestion: record ? { ...record, ...formatted } : null,
      ...(updatedPage ? { page: updatedPage } : {}),
    };
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/suggestions/accept-all
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/accept-all
   */
  @Post([
    'pages/:pageId/suggestions/accept-all',
    'docs/:pageId/suggestions/accept-all',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async acceptAllSuggestions(
    @Param('pageId') pageId: string,
    @Body() body: { suggestionIds?: string[] },
    @ResolvedProject() authorizedProjectId: string | { id: string } | null,
    @Req() req?: AuthenticatedRequest,
  ) {
    const resolvedCount = await this.batchResolvePageSuggestions(
      pageId,
      authorizedProjectId,
      true,
      body?.suggestionIds,
      req?.user?.id || req?.user?.sub || null,
    );
    return { ok: true, acceptedCount: resolvedCount };
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/suggestions/reject-all
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/reject-all
   */
  @Post([
    'pages/:pageId/suggestions/reject-all',
    'docs/:pageId/suggestions/reject-all',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async rejectAllSuggestions(
    @Param('pageId') pageId: string,
    @Body() body: { suggestionIds?: string[] },
    @ResolvedProject() authorizedProjectId: string | { id: string } | null,
    @Req() req?: AuthenticatedRequest,
  ) {
    const resolvedCount = await this.batchResolvePageSuggestions(
      pageId,
      authorizedProjectId,
      false,
      body?.suggestionIds,
      req?.user?.id || req?.user?.sub || null,
    );
    return { ok: true, rejectedCount: resolvedCount };
  }

  private async batchResolvePageSuggestions(
    pageId: string,
    authorizedProjectId: string | { id: string } | null,
    isAccept: boolean,
    suggestionIds?: string[],
    userId?: string | null,
  ): Promise<number> {
    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDocAndProject(pageId, authorizedProjectId);
    if (!targetProjectId) {
      return 0;
    }

    const docId = resolvedDocId || pageId;
    if (!this.trackChangesRepo) {
      if (this.trackChangesService) {
        const res = await this.trackChangesService.batchResolveChanges(
          targetProjectId,
          docId,
          isAccept ? 'accept_all' : 'reject_all',
          suggestionIds,
          userId,
        );
        return res.resolvedCount;
      }
      return 0;
    }

    const pendingChanges = await this.trackChangesRepo.listChangesByDoc(
      targetProjectId,
      docId,
      'pending',
    );
    const filtered =
      suggestionIds && suggestionIds.length > 0
        ? pendingChanges.filter((c) => suggestionIds.includes(c.id))
        : pendingChanges;

    if (filtered.length === 0) {
      return 0;
    }

    const normalizedChanges = filtered.map((c) =>
      TrackChange.create({
        id: c.id,
        projectId: c.projectId,
        docId: c.docId,
        type: c.type,
        text: c.text,
        range: TextRangeVo.create({
          startLine: Math.max(0, c.range.startLine > 0 ? c.range.startLine - 1 : 0),
          startCol: Math.max(0, c.range.startCol),
          endLine: Math.max(0, c.range.endLine > 0 ? c.range.endLine - 1 : 0),
          endCol: Math.max(0, c.range.endCol),
        }),
        createdById: c.createdById,
      }),
    );

    const { LinePatcher } = await import(
      '@/modules/manuscripts/track-changes/domain'
    );
    const sorted = LinePatcher.sortChangesBottomUp(normalizedChanges);

    const live = this.getLiveCollaboration();
    if (live) {
      await live.flushDocs(targetProjectId, [docId]).catch(() => []);
    }

    const doc = await this.pageScopeRepo.findDocInProject(
      targetProjectId,
      docId,
    );
    if (doc) {
      let currentLines = await this.pageService.getHydratedDocLines(doc);
      let anyMutated = false;

      for (const change of sorted) {
        const computed = isAccept
          ? LinePatcher.computeAcceptedPatch(currentLines, change)
          : LinePatcher.computeRejectedPatch(currentLines, change);
        currentLines = computed.lines;
        if (computed.mutated) {
          anyMutated = true;
        }
      }

      if (anyMutated) {
        await this.docstoreService.updateDoc(doc.projectId, doc.id, {
          lines: currentLines,
          version: doc.version + 1,
          expectedRev: doc.rev,
        });
        await this.syncLiveDoc(doc.projectId, doc.id, currentLines);
      }
    }

    const resolvedStatus = isAccept ? 'accepted' : 'rejected';
    const now = new Date();
    const resolvedById = isUuid(userId) ? userId : null;
    await this.trackChangesRepo.batchUpdateChangesStatus(
      sorted.map((c) => c.id),
      resolvedStatus,
      resolvedById,
      now,
      targetProjectId,
      docId,
    );

    for (const change of sorted) {
      this.broadcastEvent(targetProjectId, 'track-changes:resolved', {
        docId,
        change: change.toJSON(),
        action: resolvedStatus,
        resolvedById,
      });
    }

    return sorted.length;
  }

  /**
   * GET /api/v1/manuscripts/pages/:pageId/review-status
   * GET /api/v1/manuscripts/docs/:pageId/review-status
   * GET /api/v1/manuscripts/projects/:projectId/docs/:pageId/review-status
   */
  @Get([
    'pages/:pageId/review-status',
    'docs/:pageId/review-status',
    'projects/:projectId/docs/:pageId/review-status',
  ])
  @RequireRole(Role.REVIEWER)
  async getReviewStatus(
    @Param('pageId') pageId: string,
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    const { docId, projectId } = await this.resolveDocAndProject(
      pageId,
      routeProjectId || authorizedProjectId,
    );
    if (!docId || !projectId) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const review = await getDocReviewStatusWithFallback(
      this.pageScopeRepo.getPrisma(),
      this.docstoreService,
      projectId,
      docId,
    );

    return { ok: true, docId, projectId, review };
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/review-status
   * POST /api/v1/manuscripts/docs/:pageId/review-status
   * POST /api/v1/manuscripts/projects/:projectId/docs/:pageId/review-status
   */
  @Post([
    'pages/:pageId/review-status',
    'docs/:pageId/review-status',
    'projects/:projectId/docs/:pageId/review-status',
  ])
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  async updateReviewStatus(
    @Param('pageId') pageId: string,
    @Body() body: UpdateReviewStatusDto,
    @ResolvedProject() authorizedProjectId: string | { id: string } | null,
    @CurrentRole() currentRole: Role,
    @Param('projectId') routeProjectId?: string,
    @CurrentUser('id') userId?: string,
  ) {
    const { docId, projectId } = await this.resolveDocAndProject(
      pageId,
      routeProjectId || authorizedProjectId,
    );
    if (!docId || !projectId) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const doc = await this.pageScopeRepo.findDocInProject(projectId, docId);
    if (!doc) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const { review: updatedReview, previousStatus } =
      await updateDocReviewStatusWithCas({
        prisma: this.pageScopeRepo.getPrisma(),
        docstoreService: this.docstoreService,
        projectId,
        docId,
        body,
        currentRole,
        userId,
      });

    this.broadcastEvent(projectId, 'review:status-changed', {
      docId,
      projectId,
      review: updatedReview,
      previousStatus,
      updatedById: userId,
    });

    return { ok: true, docId, projectId, review: updatedReview };
  }
}
