/**
 * modules/manuscripts/docstore/controllers/pages-review.controller.ts
 * Domain-focused controller handling Inline Comments, Comment Threads,
 * and Track-Change Suggestions routes.
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
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedProject,
  CurrentRole,
} from '@/modules/project/access';
import { Prisma, ManuscriptChangeType } from '@prisma/client';
import { PrismaService, AuthenticatedRequest, isUuid } from '@/core';
import { ModuleRef } from '@nestjs/core';
import { DocstoreService } from '../docstore.service';
import { ManuscriptUserResolverService } from '../services/manuscript-user-resolver.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LiveCollaborationPort } from '@/modules/manuscripts/core';
import { ManuscriptPageScopeRepository } from '../repositories/manuscript-page-scope.repository';
import {
  resolveActiveProjectId,
  resolveDocAndProjectContext,
  resolveCreateTargetContext,
  hydrateReviewDocLines,
  validateCommentRange,
  validateSuggestionRange,
  assertCanModifyReviewItem,
  findScopedCommentThreadOrThrow,
  findScopedCommentReplyOrThrow,
  formatCommentThreadDto,
  formatSuggestionItemDto,
  formatCreatedSuggestionDto,
  findScopedTrackChangeOrThrow,
  applyAcceptedSingleSuggestionToDocstore,
  applyAcceptedBatchSuggestionsToDocstore,
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
  private readonly pageScopeRepo: ManuscriptPageScopeRepository;

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly prisma: PrismaService,
    private readonly userResolver: ManuscriptUserResolverService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() pageScopeRepo?: ManuscriptPageScopeRepository,
  ) {
    this.pageScopeRepo =
      pageScopeRepo || new ManuscriptPageScopeRepository(prisma);
  }

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
    return resolveActiveProjectId(project);
  }

  private async resolveDocAndProject(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ): Promise<{ docId?: string; projectId?: string }> {
    return resolveDocAndProjectContext(
      this.prisma,
      this.pageScopeRepo,
      pageId,
      authorizedProjectId,
    );
  }

  private async getHydratedDocLines(doc: {
    id: string;
    projectId: string;
    lines: unknown;
    inStorage?: boolean;
  }): Promise<string[]> {
    return hydrateReviewDocLines(this.docstoreService, doc);
  }

  // ─── 1. INLINE COMMENTS & THREADS ─────────────────────────────────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId/comments
   */
  @Get('docs/:pageId/comments')
  async getComments(
    @Param('pageId') pageId: string,
    @Query('status') status?: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) return { comments: [] };
    try {
      const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
      const where: Prisma.ManuscriptCommentThreadWhereInput = {
        docId: pageId,
        ...(targetProjectId ? { projectId: targetProjectId } : {}),
      };
      if (status === 'resolved') {
        where.isResolved = true;
      } else if (status === 'open') {
        where.isResolved = false;
      }
      const threads = await this.prisma.manuscriptCommentThread.findMany({
        where,
        include: { replies: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });

      const userIds: (string | null | undefined)[] = [];
      for (const t of threads) {
        userIds.push(t.createdById);
        for (const r of t.replies || []) {
          userIds.push(r.createdById);
        }
      }
      const userMap = await this.resolveUserNames(userIds);

      const comments = threads.map((t) =>
        formatCommentThreadDto(t, userMap, {
          includeAvatar: true,
          includeDocId: false,
        }),
      );

      return { comments };
    } catch {
      return { comments: [] };
    }
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/comments
   */
  @Post('docs/:pageId/comments')
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
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    const { targetDocId, projectId } = await resolveCreateTargetContext(
      this.prisma,
      pageId,
      authorizedProjectId,
      body?.projectId,
      req,
      'Valid pageId and associated project required to create a comment',
    );

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

    const thread = await this.prisma.manuscriptCommentThread.create({
      data: {
        docId: targetDocId,
        projectId,
        quote: body.content,
        startLine,
        startCol: 0,
        endLine,
        endCol: 0,
        createdById: isUuid(userId) ? userId : null,
      },
    });

    const commentPayload = {
      id: thread.id,
      page: pageId,
      projectPageId: pageId,
      docId: targetDocId,
      author: {
        id: userId || thread.createdById || 'anonymous',
        name: authorName,
      },
      content: thread.quote || '',
      line: thread.startLine,
      lineEnd: thread.endLine,
      status: 'open',
      replies: [],
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    };

    if (this.eventEmitter && projectId) {
      this.broadcastEvent(projectId, 'comment:created', {
        docId: targetDocId,
        comment: commentPayload,
      });
    }

    return { comment: commentPayload };
  }

  /**
   * PATCH /api/v1/manuscripts/docs/:pageId/comments/:commentId
   */
  @Patch('docs/:pageId/comments/:commentId')
  async updateComment(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Body() body: { content?: string; status?: 'open' | 'resolved' },
    @Req() req: AuthenticatedRequest,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    const userId = req?.user?.id || req?.user?.sub;
    const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);

    const thread = await findScopedCommentThreadOrThrow(
      this.prisma,
      this.pageScopeRepo,
      commentId,
      isUuid(pageId) ? pageId : undefined,
      targetProjectId,
      true,
    );

    assertCanModifyReviewItem(
      thread.createdById,
      userId,
      role,
      'Only the comment author or a coordinator/owner can edit this comment',
    );

    try {
      await this.prisma.manuscriptCommentThread.updateMany({
        where: {
          id: commentId,
          ...(targetProjectId ? { projectId: targetProjectId } : {}),
        },
        data: {
          ...(body.content !== undefined ? { quote: body.content } : {}),
          ...(body.status !== undefined
            ? { isResolved: body.status === 'resolved' }
            : {}),
        },
      });

      const updated = await this.prisma.manuscriptCommentThread.findUnique({
        where: { id: commentId },
        include: { replies: true },
      });

      if (!updated) {
        throw new NotFoundException(`Comment thread ${commentId} not found`);
      }

      const userMap = await this.resolveUserNames([
        updated.createdById,
        ...(updated.replies || []).map((r) => r.createdById),
      ]);
      const commentPayload = formatCommentThreadDto(updated, userMap);

      if (this.eventEmitter && updated.projectId) {
        this.broadcastEvent(updated.projectId, 'comment:updated', {
          docId: updated.docId,
          comment: commentPayload,
        });
      }

      return { comment: commentPayload };
    } catch (err) {
      if (
        err instanceof ForbiddenException ||
        err instanceof NotFoundException
      ) {
        throw err;
      }
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }
  }

  /**
   * DELETE /api/v1/manuscripts/docs/:pageId/comments/:commentId
   */
  @Delete('docs/:pageId/comments/:commentId')
  @HttpCode(HttpStatus.OK)
  async deleteComment(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Req() req: AuthenticatedRequest,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    const userId = req?.user?.id || req?.user?.sub;
    const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);

    const existing = await findScopedCommentThreadOrThrow(
      this.prisma,
      this.pageScopeRepo,
      commentId,
      isUuid(pageId) ? pageId : undefined,
      targetProjectId,
    );

    assertCanModifyReviewItem(
      existing.createdById,
      userId,
      role,
      'Only the comment author or a coordinator/owner can delete this comment',
    );

    await this.prisma.manuscriptCommentThread.deleteMany({
      where: {
        id: commentId,
        ...(targetProjectId ? { projectId: targetProjectId } : {}),
      },
    });

    if (this.eventEmitter && existing?.projectId) {
      this.broadcastEvent(existing.projectId, 'comment:deleted', {
        docId: existing.docId,
        commentId,
      });
    }
    return { success: true };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/comments/:commentId/reply
   */
  @Post([
    'docs/:pageId/comments/:commentId/reply',
    'docs/:pageId/comments/:commentId/replies',
  ])
  @HttpCode(HttpStatus.CREATED)
  async addCommentReply(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Body() body: { content: string },
    @Req() req: AuthenticatedRequest,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    try {
      const { docId: resolvedDocId, projectId: targetProjectId } =
        await this.resolveDocAndProject(pageId, authorizedProjectId);

      const existingThread = await findScopedCommentThreadOrThrow(
        this.prisma,
        this.pageScopeRepo,
        commentId,
        resolvedDocId,
        targetProjectId,
      );

      if (existingThread.isResolved) {
        throw new BadRequestException(
          'Cannot add reply to a resolved comment thread',
        );
      }

      await this.prisma.manuscriptCommentReply.create({
        data: {
          threadId: commentId,
          content: body.content,
          createdById: isUuid(userId) ? userId : null,
        },
      });

      const thread = await this.prisma.manuscriptCommentThread.findUnique({
        where: { id: commentId },
        include: { replies: { orderBy: { createdAt: 'asc' } } },
      });

      if (!thread) {
        throw new NotFoundException(`Comment thread ${commentId} not found`);
      }

      const userMap = await this.resolveUserNames([
        thread.createdById,
        ...(thread.replies || []).map((r) => r.createdById),
      ]);
      const commentPayload = formatCommentThreadDto(thread, userMap);

      if (this.eventEmitter && thread.projectId) {
        this.broadcastEvent(thread.projectId, 'comment:reply-added', {
          docId: thread.docId,
          commentId: thread.id,
          comment: commentPayload,
        });
      }

      return { comment: commentPayload };
    } catch (err) {
      if (
        err instanceof NotFoundException ||
        err instanceof BadRequestException
      ) {
        throw err;
      }
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }
  }

  /**
   * DELETE /api/v1/manuscripts/docs/:pageId/comments/:commentId/replies/:replyId
   */
  @Delete('docs/:pageId/comments/:commentId/replies/:replyId')
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

    const existingReply = await findScopedCommentReplyOrThrow(
      this.prisma,
      replyId,
      commentId,
      resolvedDocId,
      targetProjectId,
    );

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

    await this.prisma.manuscriptCommentReply
      .delete({ where: { id: replyId } })
      .catch(() => null);

    if (this.eventEmitter && existingReply?.thread?.projectId) {
      this.broadcastEvent(
        existingReply.thread.projectId,
        'comment:reply-deleted',
        {
          docId: existingReply.thread.docId,
          commentId: existingReply.thread.id,
          replyId,
        },
      );
    }

    let commentPayload = null;
    if (isUuid(commentId)) {
      const updatedThread = await this.prisma.manuscriptCommentThread
        .findUnique({
          where: { id: commentId },
          include: { replies: { orderBy: { createdAt: 'asc' } } },
        })
        .catch(() => null);
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
    }

    return { success: true, comment: commentPayload };
  }

  /**
   * PATCH /api/v1/manuscripts/docs/:pageId/comments/:commentId/resolve
   */
  @Patch('docs/:pageId/comments/:commentId/resolve')
  @RequireRole(Role.CONTRIBUTOR)
  async resolveComment(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Body() body: { resolved?: boolean },
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    const isResolved = body.resolved ?? true;
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    try {
      const { docId: resolvedDocId, projectId: targetProjectId } =
        await this.resolveDocAndProject(pageId, authorizedProjectId);

      await findScopedCommentThreadOrThrow(
        this.prisma,
        this.pageScopeRepo,
        commentId,
        resolvedDocId,
        targetProjectId,
      );

      const thread = await this.prisma.manuscriptCommentThread.update({
        where: { id: commentId },
        data: { isResolved },
        include: { replies: true },
      });

      const userMap = await this.resolveUserNames([
        thread.createdById,
        ...(thread.replies || []).map((r) => r.createdById),
      ]);
      const commentPayload = formatCommentThreadDto(thread, userMap);

      if (this.eventEmitter && thread.projectId) {
        this.broadcastEvent(thread.projectId, 'comment:resolved', {
          docId: thread.docId,
          commentId: thread.id,
          resolved: isResolved,
          comment: commentPayload,
        });
      }

      return { comment: commentPayload };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }
  }

  // ─── 2. TRACK CHANGES / REVIEW SUGGESTIONS ───────────────────────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId/suggestions
   */
  @Get('docs/:pageId/suggestions')
  async getSuggestions(
    @Param('pageId') pageId: string,
    @Query('status') status?: 'pending' | 'accepted' | 'rejected',
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) return { suggestions: [] };
    try {
      const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
      const where: Prisma.ManuscriptTrackChangeWhereInput = {
        docId: pageId,
        ...(targetProjectId ? { projectId: targetProjectId } : {}),
      };
      if (status) where.status = status;
      const records = await this.prisma.manuscriptTrackChange.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 5000,
      });

      const userMap = await this.resolveUserNames(
        records.map((s) => s.createdById),
      );

      const suggestions = records.map((s) =>
        formatSuggestionItemDto(s, userMap),
      );

      return { suggestions };
    } catch {
      return { suggestions: [] };
    }
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions
   */
  @Post('docs/:pageId/suggestions')
  @HttpCode(HttpStatus.CREATED)
  async createSuggestion(
    @Param('pageId') pageId: string,
    @Body() body: CreateSuggestionBody,
    @Req() req: AuthenticatedRequest,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    const { targetDocId, projectId } = await resolveCreateTargetContext(
      this.prisma,
      pageId,
      authorizedProjectId,
      body?.projectId,
      req,
      'Valid pageId and associated project required to create a suggestion',
    );

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

    const record = await this.prisma.manuscriptTrackChange.create({
      data: {
        docId: targetDocId,
        projectId,
        type,
        status: 'pending',
        text,
        startLine,
        startCol,
        endLine,
        endCol,
        createdById: isUuid(userId) ? userId : null,
      },
    });

    const suggestionPayload = formatCreatedSuggestionDto(
      record,
      userId,
      authorName,
      authorEmail,
    );

    if (this.eventEmitter && projectId) {
      this.broadcastEvent(projectId, 'track-changes:created', {
        docId: targetDocId,
        suggestion: suggestionPayload,
      });
    }

    return {
      suggestion: suggestionPayload,
    };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/:suggestionId/accept
   */
  @Post('docs/:pageId/suggestions/:suggestionId/accept')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async acceptSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(suggestionId)) {
      throw new BadRequestException(
        'A valid UUID is required for suggestionId',
      );
    }

    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDocAndProject(pageId, authorizedProjectId);
    const existing = await findScopedTrackChangeOrThrow(
      this.prisma,
      this.pageScopeRepo,
      suggestionId,
      resolvedDocId,
      targetProjectId,
    );

    const updatedCount = await this.prisma.manuscriptTrackChange.updateMany({
      where: {
        id: suggestionId,
        status: 'pending',
        ...(targetProjectId ? { projectId: targetProjectId } : {}),
      },
      data: { status: 'accepted', resolvedAt: new Date() },
    });

    if (updatedCount.count === 0) {
      const current = await this.prisma.manuscriptTrackChange.findUnique({
        where: { id: suggestionId },
      });
      return { ok: true, suggestion: current ?? existing };
    }

    const record = await this.prisma.manuscriptTrackChange.findUnique({
      where: { id: suggestionId },
    });

    if (record && record.docId) {
      await applyAcceptedSingleSuggestionToDocstore({
        prisma: this.prisma,
        docstoreService: this.docstoreService,
        live: this.getLiveCollaboration(),
        record,
        targetProjectId,
        syncLiveDoc: (projId, dId, lns) => this.syncLiveDoc(projId, dId, lns),
        broadcastEvent: (projId, evt, payload) =>
          this.broadcastEvent(projId, evt, payload),
        logger: this.logger,
        suggestionId,
      });
    }

    return { ok: true, suggestion: record };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/:suggestionId/reject
   */
  @Post('docs/:pageId/suggestions/:suggestionId/reject')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async rejectSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(suggestionId)) {
      throw new BadRequestException(
        'A valid UUID is required for suggestionId',
      );
    }

    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDocAndProject(pageId, authorizedProjectId);
    const existing = await findScopedTrackChangeOrThrow(
      this.prisma,
      this.pageScopeRepo,
      suggestionId,
      resolvedDocId,
      targetProjectId,
    );

    if (existing.status && existing.status !== 'pending') {
      return { ok: true, suggestion: existing };
    }
    const updatedCount = await this.prisma.manuscriptTrackChange.updateMany({
      where: {
        id: suggestionId,
        status: 'pending',
        ...(targetProjectId ? { projectId: targetProjectId } : {}),
      },
      data: { status: 'rejected', resolvedAt: new Date() },
    });

    if (updatedCount.count === 0) {
      const current = await this.prisma.manuscriptTrackChange.findUnique({
        where: { id: suggestionId },
      });
      return { ok: true, suggestion: current ?? existing };
    }

    const record = await this.prisma.manuscriptTrackChange.findUnique({
      where: { id: suggestionId },
    });

    if (this.eventEmitter && record && record.docId) {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: record.docId },
        select: { projectId: true },
      });
      if (doc?.projectId) {
        this.broadcastEvent(doc.projectId, 'track-changes:resolved', {
          docId: record.docId,
          change: record,
          action: 'rejected',
        });
      }
    }

    return { ok: true, suggestion: record };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/accept-all
   */
  @Post('docs/:pageId/suggestions/accept-all')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async acceptAllSuggestions(
    @Param('pageId') pageId: string,
    @Body() body: { suggestionIds?: string[] },
    @ResolvedProject() authorizedProjectId: string | { id: string } | null,
    @Req() req?: AuthenticatedRequest,
  ) {
    let acceptedCount = 0;
    const userId = req?.user?.id || req?.user?.sub || null;
    const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
    if (isUuid(pageId)) {
      const whereClause: Prisma.ManuscriptTrackChangeWhereInput = {
        docId: pageId,
        status: 'pending',
        ...(targetProjectId ? { projectId: targetProjectId } : {}),
      };
      if (
        body?.suggestionIds &&
        Array.isArray(body.suggestionIds) &&
        body.suggestionIds.length > 0
      ) {
        whereClause.id = { in: body.suggestionIds };
      }

      const pendingChanges = await this.prisma.manuscriptTrackChange.findMany({
        where: whereClause,
      });

      if (pendingChanges.length > 0) {
        const ids = pendingChanges.map((c) => c.id);
        const claimed = await this.prisma.manuscriptTrackChange.updateMany({
          where: { id: { in: ids }, status: 'pending' },
          data: {
            status: 'accepted',
            resolvedAt: new Date(),
            resolvedById: isUuid(userId) ? userId : null,
          },
        });

        if (claimed.count === 0) {
          return { ok: true, acceptedCount: 0 };
        }
        acceptedCount = claimed.count;

        await applyAcceptedBatchSuggestionsToDocstore({
          prisma: this.prisma,
          docstoreService: this.docstoreService,
          live: this.getLiveCollaboration(),
          pageId,
          targetProjectId,
          pendingChanges,
          ids,
          acceptedCount,
          syncLiveDoc: (projId, dId, lns) => this.syncLiveDoc(projId, dId, lns),
          broadcastEvent: (projId, evt, payload) =>
            this.broadcastEvent(projId, evt, payload),
          logger: this.logger,
        });
      }
    }
    return { ok: true, acceptedCount };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/reject-all
   */
  @Post('docs/:pageId/suggestions/reject-all')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async rejectAllSuggestions(
    @Param('pageId') pageId: string,
    @Body() body: { suggestionIds?: string[] },
    @ResolvedProject() authorizedProjectId: string | { id: string } | null,
    @Req() req?: AuthenticatedRequest,
  ) {
    let rejectedCount = 0;
    const userId = req?.user?.id || req?.user?.sub || null;
    const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
    if (isUuid(pageId)) {
      try {
        const whereClause: Prisma.ManuscriptTrackChangeWhereInput = {
          docId: pageId,
          status: 'pending',
          ...(targetProjectId ? { projectId: targetProjectId } : {}),
        };
        if (
          body?.suggestionIds &&
          Array.isArray(body.suggestionIds) &&
          body.suggestionIds.length > 0
        ) {
          whereClause.id = { in: body.suggestionIds };
        }
        const res = await this.prisma.manuscriptTrackChange.updateMany({
          where: { ...whereClause, status: 'pending' },
          data: {
            status: 'rejected',
            resolvedAt: new Date(),
            resolvedById: isUuid(userId) ? userId : null,
          },
        });
        rejectedCount = res.count;

        if (this.eventEmitter && rejectedCount > 0) {
          const doc = await this.prisma.manuscriptDoc.findUnique({
            where: { id: pageId },
            select: { projectId: true },
          });
          if (doc?.projectId) {
            this.broadcastEvent(doc.projectId, 'track-changes:resolved', {
              docId: pageId,
              bulk: true,
              action: 'reject-all',
              count: rejectedCount,
            });
          }
        }
      } catch (err) {
        this.logger.error(
          `Failed to reject suggestions for page ${pageId}: ${err}`,
        );
        throw err;
      }
    }
    return { ok: true, rejectedCount };
  }
}
