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
  Logger,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { Prisma, ManuscriptChangeType } from '@prisma/client';
import { PrismaService, AuthenticatedRequest } from '@/core';
import { ModuleRef } from '@nestjs/core';
import { DocstoreService } from '../docstore.service';
import { ManuscriptUserResolverService } from '../services/manuscript-user-resolver.service';
import { ManuscriptTextMutatorService } from '../services/manuscript-text-mutator.service';
import {
  applySuggestionToLines,
  applyBatchSuggestionsToLines,
} from '../domain/text-suggestion-mutator';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LiveCollaborationPort } from '../core/ports/live-collaboration.port';

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

const isUuid = (val?: string | null): val is string =>
  typeof val === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

@ApiTags('Manuscripts - Pages Review & Comments')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/manuscripts', 'v1/manuscripts', 'manuscripts', 'api'])
@UseGuards(JwtAuthGuard)
export class PagesReviewController {
  private readonly logger = new Logger(PagesReviewController.name);
  private liveCollab: LiveCollaborationPort | null | undefined;

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly prisma: PrismaService,
    private readonly userResolver: ManuscriptUserResolverService,
    @Optional() private readonly textMutator?: ManuscriptTextMutatorService,
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

  // ─── 1. INLINE COMMENTS & THREADS ─────────────────────────────────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId/comments
   * GET /api/pages/:pageId/comments
   */
  @Get(['docs/:pageId/comments', 'pages/:pageId/comments'])
  async getComments(
    @Param('pageId') pageId: string,
    @Query('status') status?: string,
  ) {
    if (!isUuid(pageId)) return { comments: [] };
    try {
      const where: Prisma.ManuscriptCommentThreadWhereInput = { docId: pageId };
      if (status === 'resolved') {
        where.isResolved = true;
      } else if (status === 'open') {
        where.isResolved = false;
      }
      const threads = await this.prisma.manuscriptCommentThread.findMany({
        where,
        include: { replies: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });

      const userIds: (string | null | undefined)[] = [];
      for (const t of threads) {
        userIds.push(t.createdById);
        for (const r of t.replies || []) {
          userIds.push(r.createdById);
        }
      }
      const userMap = await this.resolveUserNames(userIds);

      const comments = threads.map((t) => {
        const threadUser = t.createdById
          ? userMap.get(t.createdById)
          : undefined;
        return {
          id: t.id,
          page: t.docId,
          projectPageId: t.docId,
          author: {
            id: t.createdById || 'anonymous',
            name: threadUser?.name || 'Collaborator',
            avatar: threadUser?.avatar || '',
          },
          content: t.quote || '',
          line: t.startLine,
          lineEnd: t.endLine,
          status: t.isResolved ? 'resolved' : 'open',
          replies: (t.replies || []).map((r) => {
            const replyUser = r.createdById
              ? userMap.get(r.createdById)
              : undefined;
            return {
              id: r.id,
              author: {
                id: r.createdById || 'anonymous',
                name: replyUser?.name || 'Collaborator',
                avatar: replyUser?.avatar || '',
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
   * POST /api/v1/manuscripts/docs/:pageId/comments
   * POST /api/pages/:pageId/comments
   */
  @Post(['docs/:pageId/comments', 'pages/:pageId/comments'])
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
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    let projectId: string | null = null;
    let targetDocId = pageId;

    if (isUuid(pageId)) {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
        select: { projectId: true },
      });
      if (doc?.projectId) {
        projectId = doc.projectId;
      } else {
        const node = await this.prisma.manuscriptNode.findUnique({
          where: { id: pageId },
          select: { projectId: true, docId: true },
        });
        if (node?.projectId) projectId = node.projectId;
        if (node?.docId) targetDocId = node.docId;
      }
    }

    if (!projectId && body?.projectId && isUuid(body.projectId)) {
      projectId = body.projectId;
    }
    const headerProjId = Array.isArray(req?.headers?.['x-project-id'])
      ? req.headers['x-project-id'][0]
      : req?.headers?.['x-project-id'];
    if (!projectId && headerProjId && isUuid(headerProjId)) {
      projectId = headerProjId;
    }

    if (!isUuid(targetDocId) || !projectId) {
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

    const thread = await this.prisma.manuscriptCommentThread.create({
      data: {
        docId: targetDocId,
        projectId,
        quote: body.content,
        startLine: body.line ?? 1,
        startCol: 0,
        endLine: body.lineEnd ?? body.line ?? 1,
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
      try {
        this.broadcastEvent(projectId, 'comment:created', {
          docId: targetDocId,
          comment: commentPayload,
        });
      } catch {
        // Non-blocking real-time broadcast error ignored
      }
    }

    return { comment: commentPayload };
  }

  /**
   * PATCH /api/v1/manuscripts/docs/:pageId/comments/:commentId
   * PATCH /api/pages/:pageId/comments/:commentId
   */
  @Patch([
    'docs/:pageId/comments/:commentId',
    'pages/:pageId/comments/:commentId',
  ])
  async updateComment(
    @Param('commentId') commentId: string,
    @Body() body: { content?: string; status?: 'open' | 'resolved' },
  ) {
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    try {
      const updated = await this.prisma.manuscriptCommentThread.update({
        where: { id: commentId },
        data: {
          ...(body.content !== undefined ? { quote: body.content } : {}),
          ...(body.status !== undefined
            ? { isResolved: body.status === 'resolved' }
            : {}),
        },
        include: { replies: true },
      });

      const userMap = await this.resolveUserNames([
        updated.createdById,
        ...(updated.replies || []).map((r) => r.createdById),
      ]);
      const threadUser = updated.createdById
        ? userMap.get(updated.createdById)
        : undefined;

      const commentPayload = {
        id: updated.id,
        page: updated.docId,
        projectPageId: updated.docId,
        docId: updated.docId,
        author: {
          id: updated.createdById || 'anonymous',
          name: threadUser?.name || 'Collaborator',
        },
        content: updated.quote || '',
        line: updated.startLine,
        lineEnd: updated.endLine,
        status: updated.isResolved ? 'resolved' : 'open',
        replies: (updated.replies || []).map((r) => {
          const replyUser = r.createdById
            ? userMap.get(r.createdById)
            : undefined;
          return {
            id: r.id,
            author: {
              id: r.createdById || 'anonymous',
              name: replyUser?.name || 'Collaborator',
            },
            content: r.content,
            createdAt: r.createdAt.toISOString(),
          };
        }),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      };

      if (this.eventEmitter && updated.projectId) {
        try {
          this.broadcastEvent(updated.projectId, 'comment:updated', {
            docId: updated.docId,
            comment: commentPayload,
          });
        } catch {
          // ignore non-blocking error
        }
      }

      return { comment: commentPayload };
    } catch {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }
  }

  /**
   * DELETE /api/v1/manuscripts/docs/:pageId/comments/:commentId
   * DELETE /api/pages/:pageId/comments/:commentId
   */
  @Delete([
    'docs/:pageId/comments/:commentId',
    'pages/:pageId/comments/:commentId',
  ])
  @HttpCode(HttpStatus.OK)
  async deleteComment(@Param('commentId') commentId: string) {
    if (isUuid(commentId)) {
      const existing = await this.prisma.manuscriptCommentThread.findUnique({
        where: { id: commentId },
        select: { projectId: true, docId: true },
      });
      await this.prisma.manuscriptCommentThread
        .delete({ where: { id: commentId } })
        .catch(() => null);

      if (this.eventEmitter && existing?.projectId) {
        try {
          this.broadcastEvent(existing.projectId, 'comment:deleted', {
            docId: existing.docId,
            commentId,
          });
        } catch {
          // ignore non-blocking error
        }
      }
    }
    return { success: true };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/comments/:commentId/reply
   * POST /api/pages/:pageId/comments/:commentId/reply
   */
  @Post([
    'docs/:pageId/comments/:commentId/reply',
    'docs/:pageId/comments/:commentId/replies',
    'pages/:pageId/comments/:commentId/reply',
    'pages/:pageId/comments/:commentId/replies',
  ])
  @HttpCode(HttpStatus.CREATED)
  async addCommentReply(
    @Param('commentId') commentId: string,
    @Body() body: { content: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    try {
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
      const threadUser = thread.createdById
        ? userMap.get(thread.createdById)
        : undefined;

      const commentPayload = {
        id: thread.id,
        page: thread.docId,
        projectPageId: thread.docId,
        docId: thread.docId,
        author: {
          id: thread.createdById || 'anonymous',
          name: threadUser?.name || 'Collaborator',
        },
        content: thread.quote || '',
        line: thread.startLine,
        lineEnd: thread.endLine,
        status: thread.isResolved ? 'resolved' : 'open',
        replies: (thread.replies || []).map((r) => {
          const replyUser = r.createdById
            ? userMap.get(r.createdById)
            : undefined;
          return {
            id: r.id,
            author: {
              id: r.createdById || 'anonymous',
              name: replyUser?.name || 'Collaborator',
            },
            content: r.content,
            createdAt: r.createdAt.toISOString(),
          };
        }),
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      };

      if (this.eventEmitter && thread.projectId) {
        try {
          this.broadcastEvent(thread.projectId, 'comment:replied', {
            docId: thread.docId,
            threadId: thread.id,
            commentId: thread.id,
            comment: commentPayload,
          });
          this.broadcastEvent(thread.projectId, 'comment:reply-added', {
            docId: thread.docId,
            commentId: thread.id,
            comment: commentPayload,
          });
        } catch {
          // ignore non-blocking error
        }
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
   * DELETE /api/pages/:pageId/comments/:commentId/replies/:replyId
   */
  @Delete([
    'docs/:pageId/comments/:commentId/replies/:replyId',
    'pages/:pageId/comments/:commentId/replies/:replyId',
  ])
  @HttpCode(HttpStatus.OK)
  async deleteCommentReply(
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
  ) {
    if (isUuid(replyId)) {
      const existingReply = await this.prisma.manuscriptCommentReply.findUnique(
        {
          where: { id: replyId },
          include: {
            thread: { select: { projectId: true, docId: true, id: true } },
          },
        },
      );
      await this.prisma.manuscriptCommentReply
        .delete({ where: { id: replyId } })
        .catch(() => null);

      if (this.eventEmitter && existingReply?.thread?.projectId) {
        try {
          this.broadcastEvent(
            existingReply.thread.projectId,
            'comment:reply-deleted',
            {
              docId: existingReply.thread.docId,
              commentId: existingReply.thread.id,
              replyId,
            },
          );
        } catch {
          // ignore non-blocking error
        }
      }
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
        const threadUser = updatedThread.createdById
          ? userMap.get(updatedThread.createdById)
          : undefined;
        commentPayload = {
          id: updatedThread.id,
          page: updatedThread.docId,
          projectPageId: updatedThread.docId,
          author: {
            id: updatedThread.createdById || 'anonymous',
            name: threadUser?.name || 'Collaborator',
            avatar: threadUser?.avatar || '',
          },
          content: updatedThread.quote || '',
          line: updatedThread.startLine,
          lineEnd: updatedThread.endLine,
          status: updatedThread.isResolved ? 'resolved' : 'open',
          replies: (updatedThread.replies || []).map((r) => {
            const replyUser = r.createdById
              ? userMap.get(r.createdById)
              : undefined;
            return {
              id: r.id,
              author: {
                id: r.createdById || 'anonymous',
                name: replyUser?.name || 'Collaborator',
                avatar: replyUser?.avatar || '',
              },
              content: r.content,
              createdAt: r.createdAt.toISOString(),
            };
          }),
          createdAt: updatedThread.createdAt.toISOString(),
          updatedAt: updatedThread.updatedAt.toISOString(),
        };
      }
    }

    return { success: true, comment: commentPayload };
  }

  /**
   * PATCH /api/v1/manuscripts/docs/:pageId/comments/:commentId/resolve
   * PATCH /api/pages/:pageId/comments/:commentId/resolve
   */
  @Patch([
    'docs/:pageId/comments/:commentId/resolve',
    'pages/:pageId/comments/:commentId/resolve',
  ])
  async resolveComment(
    @Param('commentId') commentId: string,
    @Body() body: { resolved?: boolean },
  ) {
    const isResolved = body.resolved ?? true;
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    try {
      const thread = await this.prisma.manuscriptCommentThread.update({
        where: { id: commentId },
        data: { isResolved },
        include: { replies: true },
      });

      const userMap = await this.resolveUserNames([
        thread.createdById,
        ...(thread.replies || []).map((r) => r.createdById),
      ]);
      const threadUser = thread.createdById
        ? userMap.get(thread.createdById)
        : undefined;

      const commentPayload = {
        id: thread.id,
        page: thread.docId,
        projectPageId: thread.docId,
        docId: thread.docId,
        author: {
          id: thread.createdById || 'anonymous',
          name: threadUser?.name || 'Collaborator',
        },
        content: thread.quote || '',
        line: thread.startLine,
        lineEnd: thread.endLine,
        status: thread.isResolved ? 'resolved' : 'open',
        replies: (thread.replies || []).map((r) => {
          const replyUser = r.createdById
            ? userMap.get(r.createdById)
            : undefined;
          return {
            id: r.id,
            author: {
              id: r.createdById || 'anonymous',
              name: replyUser?.name || 'Collaborator',
            },
            content: r.content,
            createdAt: r.createdAt.toISOString(),
          };
        }),
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      };

      if (this.eventEmitter && thread.projectId) {
        try {
          this.broadcastEvent(thread.projectId, 'comment:resolved', {
            docId: thread.docId,
            commentId: thread.id,
            resolved: isResolved,
            comment: commentPayload,
          });
        } catch {
          // ignore non-blocking error
        }
      }

      return { comment: commentPayload };
    } catch {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }
  }

  // ─── 2. TRACK CHANGES / REVIEW SUGGESTIONS ───────────────────────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId/suggestions
   * GET /api/pages/:pageId/suggestions
   */
  @Get(['docs/:pageId/suggestions', 'pages/:pageId/suggestions'])
  async getSuggestions(
    @Param('pageId') pageId: string,
    @Query('status') status?: 'pending' | 'accepted' | 'rejected',
  ) {
    if (!isUuid(pageId)) return { suggestions: [] };
    try {
      const where: Prisma.ManuscriptTrackChangeWhereInput = { docId: pageId };
      if (status) where.status = status;
      const records = await this.prisma.manuscriptTrackChange.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 5000,
      });

      const userMap = await this.resolveUserNames(
        records.map((s) => s.createdById),
      );

      const suggestions = records.map((s) => {
        const authorUser = s.createdById
          ? userMap.get(s.createdById)
          : undefined;
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
          fromLine: s.startLine,
          fromColumn: s.startCol,
          toLine: s.endLine,
          toColumn: s.endCol,
          description: null,
          status: s.status,
          resolvedById: s.resolvedById,
          resolvedAt: s.resolvedAt ? s.resolvedAt.toISOString() : null,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        };
      });

      return { suggestions };
    } catch {
      return { suggestions: [] };
    }
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions
   * POST /api/pages/:pageId/suggestions
   */
  @Post(['docs/:pageId/suggestions', 'pages/:pageId/suggestions'])
  @HttpCode(HttpStatus.CREATED)
  async createSuggestion(
    @Param('pageId') pageId: string,
    @Body() body: CreateSuggestionBody,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    let projectId: string | null = null;
    let targetDocId = pageId;

    if (isUuid(pageId)) {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
        select: { projectId: true },
      });
      if (doc?.projectId) {
        projectId = doc.projectId;
      } else {
        const node = await this.prisma.manuscriptNode.findUnique({
          where: { id: pageId },
          select: { projectId: true, docId: true },
        });
        if (node?.projectId) projectId = node.projectId;
        if (node?.docId) targetDocId = node.docId;
      }
    }

    if (!projectId && body?.projectId && isUuid(body.projectId)) {
      projectId = body.projectId;
    }
    const headerProjId = Array.isArray(req?.headers?.['x-project-id'])
      ? req.headers['x-project-id'][0]
      : req?.headers?.['x-project-id'];
    if (!projectId && headerProjId && isUuid(headerProjId)) {
      projectId = headerProjId;
    }

    const type: ManuscriptChangeType =
      body.type === 'delete'
        ? ManuscriptChangeType.delete
        : ManuscriptChangeType.insert;
    const text = body.suggestedText || body.originalText || '';

    if (!isUuid(targetDocId) || !projectId) {
      throw new BadRequestException(
        'Valid pageId and associated project required to create a suggestion',
      );
    }

    const userMap = await this.resolveUserNames([userId]);
    const resolvedUser = userId ? userMap.get(userId) : undefined;
    const authorName =
      resolvedUser?.name ||
      req?.user?.name ||
      req?.user?.email?.split('@')[0] ||
      'Collaborator';
    const authorEmail = req?.user?.email || '';

    const record = await this.prisma.manuscriptTrackChange.create({
      data: {
        docId: targetDocId,
        projectId,
        type,
        status: 'pending',
        text,
        startLine: body.fromLine ?? 1,
        startCol: body.fromColumn ?? 0,
        endLine: body.toLine ?? body.fromLine ?? 1,
        endCol: body.toColumn ?? 0,
        createdById: isUuid(userId) ? userId : null,
      },
    });

    const suggestionPayload = {
      id: record.id,
      pageId: record.docId,
      authorId: userId || 'anonymous',
      author: {
        id: userId || 'anonymous',
        name: authorName,
        email: authorEmail,
      },
      type: record.type,
      originalText: record.type === 'delete' ? record.text : '',
      suggestedText: record.type === 'insert' ? record.text : '',
      fromLine: record.startLine,
      fromColumn: record.startCol,
      toLine: record.endLine,
      toColumn: record.endCol,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };

    if (this.eventEmitter && projectId) {
      try {
        this.broadcastEvent(projectId, 'track-changes:recorded', {
          docId: targetDocId,
          suggestion: suggestionPayload,
        });
        this.broadcastEvent(projectId, 'track-changes:created', {
          docId: targetDocId,
          suggestion: suggestionPayload,
        });
      } catch {
        // ignore non-blocking error
      }
    }

    return {
      suggestion: suggestionPayload,
    };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/:suggestionId/accept
   * POST /api/pages/:pageId/suggestions/:suggestionId/accept
   */
  @Post([
    'docs/:pageId/suggestions/:suggestionId/accept',
    'pages/:pageId/suggestions/:suggestionId/accept',
  ])
  @HttpCode(HttpStatus.OK)
  async acceptSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
  ) {
    if (isUuid(suggestionId)) {
      try {
        const record = await this.prisma.manuscriptTrackChange.update({
          where: { id: suggestionId },
          data: { status: 'accepted', resolvedAt: new Date() },
        });

        // Apply accepted mutation to docstore lines with column and multi-line precision
        if (record && record.docId) {
          try {
            const doc = await this.prisma.manuscriptDoc.findUnique({
              where: { id: record.docId },
              select: {
                lines: true,
                rev: true,
                version: true,
                projectId: true,
              },
            });
            if (doc && Array.isArray(doc.lines)) {
              const lines: string[] = doc.lines.map((l) => String(l ?? ''));
              if (this.textMutator) {
                this.textMutator.applySuggestionToLines(lines, record);
              } else {
                applySuggestionToLines(lines, record);
              }

              if (doc.projectId) {
                await this.docstoreService.updateDoc(
                  doc.projectId,
                  record.docId,
                  {
                    lines,
                    version: (doc.version || 0) + 1,
                  },
                );
                await this.syncLiveDoc(doc.projectId, record.docId, lines);
              }

              if (this.eventEmitter && doc.projectId) {
                this.broadcastEvent(doc.projectId, 'track-changes:resolved', {
                  docId: record.docId,
                  change: record,
                  action: 'accepted',
                });
              }
            }
          } catch (patchErr) {
            this.logger.warn(
              `Could not apply accepted track-change to docstore: ${patchErr}`,
            );
          }
        }

        return { ok: true, suggestion: record };
      } catch {
        // Ignore
      }
    }
    return { ok: true };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/:suggestionId/reject
   * POST /api/pages/:pageId/suggestions/:suggestionId/reject
   */
  @Post([
    'docs/:pageId/suggestions/:suggestionId/reject',
    'pages/:pageId/suggestions/:suggestionId/reject',
  ])
  @HttpCode(HttpStatus.OK)
  async rejectSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
  ) {
    if (isUuid(suggestionId)) {
      try {
        const record = await this.prisma.manuscriptTrackChange.update({
          where: { id: suggestionId },
          data: { status: 'rejected', resolvedAt: new Date() },
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
      } catch {
        // Ignore
      }
    }
    return { ok: true };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/accept-all
   * POST /api/pages/:pageId/suggestions/accept-all
   */
  @Post([
    'docs/:pageId/suggestions/accept-all',
    'pages/:pageId/suggestions/accept-all',
  ])
  @HttpCode(HttpStatus.OK)
  async acceptAllSuggestions(
    @Param('pageId') pageId: string,
    @Body() body?: { suggestionIds?: string[] },
  ) {
    let acceptedCount = 0;
    if (isUuid(pageId)) {
      try {
        const whereClause: Prisma.ManuscriptTrackChangeWhereInput = {
          docId: pageId,
          status: 'pending',
        };
        if (
          body?.suggestionIds &&
          Array.isArray(body.suggestionIds) &&
          body.suggestionIds.length > 0
        ) {
          whereClause.id = { in: body.suggestionIds };
        }

        const pendingChanges = await this.prisma.manuscriptTrackChange.findMany(
          {
            where: whereClause,
          },
        );

        if (pendingChanges.length > 0) {
          const doc = await this.prisma.manuscriptDoc.findUnique({
            where: { id: pageId },
            select: { lines: true, rev: true, version: true, projectId: true },
          });

          if (doc && Array.isArray(doc.lines)) {
            const lines: string[] = doc.lines.map((l) => String(l ?? ''));
            if (this.textMutator) {
              this.textMutator.applyBatchSuggestionsToLines(
                lines,
                pendingChanges,
              );
            } else {
              applyBatchSuggestionsToLines(lines, pendingChanges);
            }

            if (doc.projectId) {
              await this.docstoreService.updateDoc(doc.projectId, pageId, {
                lines,
                version: (doc.version || 0) + 1,
              });
              await this.syncLiveDoc(doc.projectId, pageId, lines);
            }
          }

          const res = await this.prisma.manuscriptTrackChange.updateMany({
            where: { id: { in: pendingChanges.map((c) => c.id) } },
            data: { status: 'accepted', resolvedAt: new Date() },
          });
          acceptedCount = res.count;

          if (this.eventEmitter && acceptedCount > 0 && doc?.projectId) {
            this.broadcastEvent(doc.projectId, 'track-changes:resolved', {
              docId: pageId,
              bulk: true,
              action: 'accept-all',
              count: acceptedCount,
            });
          }
        }
      } catch {
        // Ignore
      }
    }
    return { ok: true, acceptedCount };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/reject-all
   * POST /api/pages/:pageId/suggestions/reject-all
   */
  @Post([
    'docs/:pageId/suggestions/reject-all',
    'pages/:pageId/suggestions/reject-all',
  ])
  @HttpCode(HttpStatus.OK)
  async rejectAllSuggestions(
    @Param('pageId') pageId: string,
    @Body() body?: { suggestionIds?: string[] },
  ) {
    let rejectedCount = 0;
    if (isUuid(pageId)) {
      try {
        const whereClause: Prisma.ManuscriptTrackChangeWhereInput = {
          docId: pageId,
          status: 'pending',
        };
        if (
          body?.suggestionIds &&
          Array.isArray(body.suggestionIds) &&
          body.suggestionIds.length > 0
        ) {
          whereClause.id = { in: body.suggestionIds };
        }
        const res = await this.prisma.manuscriptTrackChange.updateMany({
          where: whereClause,
          data: { status: 'rejected', resolvedAt: new Date() },
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
      } catch {
        // Ignore
      }
    }
    return { ok: true, rejectedCount };
  }
}
