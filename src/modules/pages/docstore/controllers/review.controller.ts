/**
 * modules/manuscripts/docstore/controllers/review.controller.ts
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
  Inject,
  Optional,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  ProjectRolePolicy,
  ResourceAccessPolicy,
  RequireRole,
  Role,
  ResolvedSpace,
  CurrentRole,
} from '@/modules/project/access';
import { PageChangeType } from '@prisma/client';
import { UpdateReviewStatusDto } from '../dto/review-status.dto';
import { AuthenticatedRequest, isUuid } from '@/core';
import { DocstoreService } from '../docstore.service';
import { PageService } from '@/modules/pages/core/services/page.service';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '@/modules/pages/core';
import { ScopeRepository } from '../repositories/scope.repository';
import { TrackChangesService } from '@/modules/pages/track-changes/track-changes.service';
import { TrackChangesRepository } from '@/modules/pages/track-changes/track-changes.repository';
import { PagesNotificationsService } from '@/modules/notifications/pages/pages-notifications.service';
import {
  CommentThread,
  CommentReply,
  TrackChange,
  TextRangeVo,
  StaleTrackChangeAnchorException,
} from '@/modules/pages/track-changes/domain';
import {
  validateCommentRange,
  validateSuggestionRange,
  assertCanModifyReviewItem,
  formatCommentThreadDto,
  formatSuggestionItemDto,
  getDocReviewStatusWithFallback,
  updateDocReviewStatusWithCas,
  buildProjectReviewOverview,
} from './review.helpers';

export interface CreateSuggestionBody {
  type?: string;
  suggestedText?: string;
  originalText?: string;
  fromLine?: number;
  fromColumn?: number;
  toLine?: number;
  toColumn?: number;
  spaceId?: string;
  [key: string]: unknown;
}

@ApiTags('Manuscripts - Pages Review & Comments')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class ReviewController {
  private readonly logger = new Logger(ReviewController.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly pageScopeRepo: ScopeRepository,
    private readonly userResolver: UserResolverService,
    private readonly pageService: PageService,
    @Optional()
    private readonly trackChangesService?: TrackChangesService,
    @Optional()
    private readonly trackChangesRepo?: TrackChangesRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?: LiveCollaborationPort | unknown,
    @Optional()
    private readonly pagesNotifications?: PagesNotificationsService,
  ) {
    this.liveCollab =
      liveCollabOrLegacyRef &&
      typeof (liveCollabOrLegacyRef as LiveCollaborationPort)
        .applyExternalText === 'function'
        ? (liveCollabOrLegacyRef as LiveCollaborationPort)
        : NOOP_LIVE_COLLABORATION;
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

  private getLiveCollaboration(): LiveCollaborationPort {
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

  private getRecordSpaceId(
    record?: { spaceId?: string; projectId?: string } | null,
  ): string {
    return record?.spaceId ?? record?.projectId ?? '';
  }

  private async resolveDocAndProject(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ): Promise<{ docId?: string; projectId?: string; pageId?: string }> {
    const activeProjectId = this.resolveActiveProjectId(authorizedProjectId);
    if (!isUuid(pageId)) {
      return { projectId: activeProjectId };
    }
    const doc = activeProjectId
      ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
      : null;
    if (doc) {
      return {
        docId: doc.id,
        projectId: this.getRecordSpaceId(doc) || activeProjectId,
        pageId: doc.pageId ?? undefined,
      };
    }

    const prisma =
      typeof this.pageScopeRepo.getPrisma === 'function'
        ? this.pageScopeRepo.getPrisma()
        : undefined;
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

    const resolvedProj = await this.pageService.resolveProjectId(pageId);
    return { docId: pageId, projectId: resolvedProj || activeProjectId };
  }

  private async resolveSpaceNotificationContext(
    spaceOrProjectId: string,
    pageIdHint?: string | null,
    docIdHint?: string | null,
  ): Promise<{
    spaceId: string;
    projectId: string | null;
    projectName?: string;
    pageId?: string | null;
    isPersonalSpace: boolean;
    collaboratorMap: Record<string, string>;
    fallbackOwnerId?: string | null;
  }> {
    const collaboratorMap: Record<string, string> = {};
    const addCollaboratorEntries = (
      id: string,
      name?: string | null,
      email?: string | null,
    ) => {
      if (!id) return;
      if (email) {
        const lowerEmail = email.toLowerCase();
        collaboratorMap[lowerEmail] = id;
        const localPart = lowerEmail.split('@')[0];
        if (localPart) collaboratorMap[localPart] = id;
      }
      if (name) {
        const lowerName = name.toLowerCase().trim();
        collaboratorMap[lowerName] = id;
        collaboratorMap[lowerName.replace(/\s+/g, '')] = id;
        collaboratorMap[lowerName.replace(/\s+/g, '_')] = id;
        collaboratorMap[lowerName.replace(/\s+/g, '.')] = id;
      }
    };

    const prisma =
      typeof this.pageScopeRepo.getPrisma === 'function'
        ? this.pageScopeRepo.getPrisma()
        : undefined;

    let spaceId = spaceOrProjectId;
    let projectId: string | null = spaceOrProjectId;
    let projectName: string | undefined;
    let isPersonalSpace = false;
    let fallbackOwnerId: string | null = null;
    let canonicalPageId = pageIdHint ?? null;

    if (prisma) {
      if (!canonicalPageId && docIdHint) {
        const doc = await Promise.resolve(
          prisma.pageDoc?.findFirst?.({
            where: { id: docIdHint },
            select: { pageId: true },
          }),
        ).catch(() => null);
        if (doc?.pageId) canonicalPageId = doc.pageId;
      }

      const space = await Promise.resolve(
        prisma.space?.findFirst?.({
          where: {
            OR: [{ id: spaceOrProjectId }, { projectId: spaceOrProjectId }],
          },
          select: {
            id: true,
            type: true,
            ownerUserId: true,
            projectId: true,
          },
        }),
      ).catch(() => null);

      if (space) {
        spaceId = space.id;
        isPersonalSpace = space.type === 'personal';
        projectId = isPersonalSpace ? null : (space.projectId ?? null);
        if (isPersonalSpace && space.ownerUserId) {
          fallbackOwnerId = space.ownerUserId;
          const [owner, ownerNames] = await Promise.all([
            Promise.resolve(
              prisma.user?.findUnique?.({
                where: { id: space.ownerUserId },
                select: { id: true, email: true },
              }),
            ).catch(() => null),
            this.resolveUserNames([space.ownerUserId]).catch(
              () => new Map<string, { id: string; name: string }>(),
            ),
          ]);
          const ownerId = owner?.id || space.ownerUserId;
          addCollaboratorEntries(
            ownerId,
            ownerNames.get(ownerId)?.name,
            owner?.email,
          );
        }
      }

      const lookupProjectId = projectId;
      if (lookupProjectId) {
        const project = await Promise.resolve(
          prisma.project?.findFirst?.({
            where: { id: lookupProjectId, deletedAt: null },
            include: {
              members: {
                select: {
                  userId: true,
                  user: { select: { id: true, email: true } },
                },
              },
            },
          }),
        ).catch(() => null);
        if (project) {
          projectName = project.name;
          fallbackOwnerId = project.createdById;
          const memberIds = [
            project.createdById,
            ...(project.members || []).map((m) => m.userId),
          ];
          const [resolvedNames, ownerUser] = await Promise.all([
            this.resolveUserNames(memberIds).catch(
              () => new Map<string, { id: string; name: string }>(),
            ),
            Promise.resolve(
              prisma.user?.findUnique?.({
                where: { id: project.createdById },
                select: { id: true, email: true },
              }),
            ).catch(() => null),
          ]);
          addCollaboratorEntries(
            project.createdById,
            resolvedNames.get(project.createdById)?.name,
            ownerUser?.email,
          );
          for (const m of project.members || []) {
            addCollaboratorEntries(
              m.userId,
              resolvedNames.get(m.userId)?.name,
              m.user?.email,
            );
          }
        }
      }
    }

    return {
      spaceId,
      projectId,
      projectName,
      pageId: canonicalPageId,
      isPersonalSpace,
      collaboratorMap,
      fallbackOwnerId,
    };
  }

  private async dispatchReviewNotificationSafe(
    label: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    if (!this.pagesNotifications) return;
    try {
      await fn();
    } catch (err) {
      this.logger.warn(
        `Non-blocking notification dispatch (${label}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
    'spaces/:spaceId/docs/:pageId/comments',
  ])
  async getComments(
    @Param('pageId') pageId: string,
    @Query('status') status?: string,
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) return { comments: [] };
    try {
      const { docId: resolvedDocId, projectId: resolvedProj } =
        await this.resolveDocAndProject(
          pageId,
          authorizedProjectId || routeProjectId,
        );
      const targetProjectId =
        resolvedProj ||
        this.resolveActiveProjectId(authorizedProjectId) ||
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
    'spaces/:spaceId/docs/:pageId/comments',
  ])
  @HttpCode(HttpStatus.CREATED)
  async createComment(
    @Param('pageId') pageId: string,
    @Body()
    body: {
      content: string;
      line?: number;
      lineEnd?: number;
      spaceId?: string;
    },
    @Req() req: AuthenticatedRequest,
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    const activeProj =
      this.resolveActiveProjectId(authorizedProjectId) || routeProjectId;
    const {
      docId: resolvedDocId,
      projectId: docProjId,
      pageId: resolvedPageId,
    } = await this.resolveDocAndProject(pageId, activeProj || body?.spaceId);
    const resolvedProj =
      docProjId ||
      activeProj ||
      body?.spaceId ||
      (await this.pageService.resolveProjectId(pageId));
    const targetDocId = resolvedDocId || pageId;
    if (!resolvedProj || !isUuid(resolvedProj) || !isUuid(targetDocId)) {
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
      spaceId: resolvedProj,
      pageId: resolvedPageId ?? null,
      docId: targetDocId,
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

    this.broadcastEvent(resolvedProj, 'comment:created', {
      docId: targetDocId,
      comment: commentPayload,
    });

    if (this.pagesNotifications && userId && isUuid(userId)) {
      await this.dispatchReviewNotificationSafe(
        'createComment:mentions',
        async () => {
          const ctx = await this.resolveSpaceNotificationContext(
            resolvedProj,
            resolvedPageId,
            targetDocId,
          );
          await this.pagesNotifications?.parseAndNotifyMentions({
            text: body.content,
            actorId: userId,
            actorName: authorName,
            spaceId: ctx.spaceId,
            projectId: ctx.projectId,
            projectName: ctx.projectName,
            pageId: ctx.pageId,
            docId: targetDocId,
            threadId: saved.id,
            isPersonalSpace: ctx.isPersonalSpace,
            collaboratorMap: ctx.collaboratorMap,
          });
        },
      );
    }

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
    'spaces/:spaceId/docs/:pageId/comments/:commentId',
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
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    const userId = req?.user?.id || req?.user?.sub;
    const { docId: resolvedDocId, projectId: resolvedProj } =
      await this.resolveDocAndProject(
        pageId,
        authorizedProjectId || routeProjectId,
      );
    const targetProjectId =
      resolvedProj ||
      this.resolveActiveProjectId(authorizedProjectId) ||
      routeProjectId;

    const thread = targetProjectId
      ? await this.pageScopeRepo.findThreadInProject(
          targetProjectId,
          commentId,
          resolvedDocId,
        )
      : null;

    if (!thread) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }

    const reqCtx = req as
      { projectMember?: { permissionBitmask?: string } } | undefined;
    const permissionBitmask = reqCtx?.projectMember?.permissionBitmask;

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

    if (body.content !== undefined && thread.createdById) {
      new ResourceAccessPolicy().assertCanModifyComment(
        {
          userId: userId ?? '',
          role: role ?? Role.REVIEWER,
          permissionBitmask,
        },
        { id: commentId, authorId: thread.createdById },
        'update',
      );
    } else if (body.content !== undefined && !thread.createdById) {
      assertCanModifyReviewItem(
        thread.createdById,
        userId,
        role,
        'Only the comment author or a coordinator/owner can edit this comment',
      );
    }

    let isResolved = thread.isResolved;
    if (body.resolved !== undefined) {
      isResolved = Boolean(body.resolved);
    } else if (body.status !== undefined) {
      isResolved = body.status === 'resolved';
    }
    const quote = body.content !== undefined ? body.content : thread.quote;

    const threadProjectId = this.getRecordSpaceId(thread);
    await this.pageScopeRepo.updateThreadInProject(threadProjectId, commentId, {
      quote,
      isResolved,
    });

    const updated = await this.pageScopeRepo.findThreadInProject(
      threadProjectId,
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

    this.broadcastEvent(this.getRecordSpaceId(updated), 'comment:updated', {
      docId: updated.docId,
      comment: commentPayload,
    });

    if (
      this.pagesNotifications &&
      userId &&
      isUuid(userId) &&
      (body.resolved !== undefined || body.status !== undefined) &&
      isResolved !== thread.isResolved
    ) {
      await this.dispatchReviewNotificationSafe(
        'updateComment:resolved',
        async () => {
          if (!isResolved) {
            await this.pagesNotifications?.dismissThreadResolved(updated.id);
            return;
          }
          if (updated.createdById && updated.createdById !== userId) {
            const ctx = await this.resolveSpaceNotificationContext(
              threadProjectId,
              (updated as { pageId?: string | null }).pageId,
              updated.docId,
            );
            const actorName = userMap.get(userId)?.name || 'Collaborator';
            await this.pagesNotifications?.notifyThreadResolved({
              recipientUserId: updated.createdById,
              actorId: userId,
              actorName,
              spaceId: ctx.spaceId,
              projectId: ctx.projectId,
              projectName: ctx.projectName,
              pageId: ctx.pageId,
              docId: updated.docId,
              threadId: updated.id,
              quote: updated.quote || undefined,
              isPersonalSpace: ctx.isPersonalSpace,
            });
          }
        },
      );
    }

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
    'spaces/:spaceId/docs/:pageId/comments/:commentId',
  ])
  @HttpCode(HttpStatus.OK)
  async deleteComment(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Req() req: AuthenticatedRequest,
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    const userId = req?.user?.id || req?.user?.sub;
    const { docId: resolvedDocId, projectId: resolvedProj } =
      await this.resolveDocAndProject(
        pageId,
        authorizedProjectId || routeProjectId,
      );
    const targetProjectId =
      resolvedProj ||
      this.resolveActiveProjectId(authorizedProjectId) ||
      routeProjectId;

    const existing = targetProjectId
      ? await this.pageScopeRepo.findThreadInProject(
          targetProjectId,
          commentId,
          resolvedDocId,
        )
      : null;

    if (!existing) {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }

    const reqCtx = req as
      { projectMember?: { permissionBitmask?: string } } | undefined;
    if (existing.createdById && role !== Role.COORDINATOR) {
      new ResourceAccessPolicy().assertCanModifyComment(
        {
          userId: userId ?? '',
          role: role ?? Role.REVIEWER,
          permissionBitmask: reqCtx?.projectMember?.permissionBitmask,
        },
        { id: commentId, authorId: existing.createdById },
        'delete',
      );
    } else {
      assertCanModifyReviewItem(
        existing.createdById,
        userId,
        role,
        'Only the comment author or a coordinator/owner can delete this comment',
      );
    }

    const existingProjectId = this.getRecordSpaceId(existing);
    await this.pageScopeRepo.deleteThreadInProject(
      existingProjectId,
      commentId,
    );

    this.broadcastEvent(existingProjectId, 'comment:deleted', {
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
    'spaces/:spaceId/docs/:pageId/comments/:commentId/reply',
    'spaces/:spaceId/docs/:pageId/comments/:commentId/replies',
  ])
  @HttpCode(HttpStatus.CREATED)
  async addCommentReply(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Body() body: { content: string },
    @Req() req: AuthenticatedRequest,
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
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

    this.broadcastEvent(this.getRecordSpaceId(thread), 'comment:reply-added', {
      docId: thread.docId,
      commentId: thread.id,
      comment: commentPayload,
    });

    if (this.pagesNotifications && userId && isUuid(userId)) {
      await this.dispatchReviewNotificationSafe('addCommentReply', async () => {
        const ctx = await this.resolveSpaceNotificationContext(
          this.getRecordSpaceId(thread) || targetProjectId,
          (thread as { pageId?: string | null }).pageId,
          thread.docId,
        );
        const replyActor = await this.resolveUserNames([userId]);
        const actorName = replyActor.get(userId)?.name || 'Collaborator';
        const lastReply =
          thread.replies && thread.replies.length > 0
            ? thread.replies[thread.replies.length - 1]
            : null;
        const replyId = lastReply?.id || replyEntity.id;

        if (thread.createdById && thread.createdById !== userId) {
          await this.pagesNotifications?.notifyCommentReply({
            recipientUserId: thread.createdById,
            actorId: userId,
            actorName,
            spaceId: ctx.spaceId,
            projectId: ctx.projectId,
            projectName: ctx.projectName,
            pageId: ctx.pageId,
            docId: thread.docId,
            threadId: thread.id,
            replyId,
            snippet: body.content,
            isPersonalSpace: ctx.isPersonalSpace,
          });
        }

        await this.pagesNotifications?.parseAndNotifyMentions({
          text: body.content,
          actorId: userId,
          actorName,
          spaceId: ctx.spaceId,
          projectId: ctx.projectId,
          projectName: ctx.projectName,
          pageId: ctx.pageId,
          docId: thread.docId,
          threadId: thread.id,
          commentId: replyId,
          isPersonalSpace: ctx.isPersonalSpace,
          collaboratorMap: ctx.collaboratorMap,
        });
      });
    }

    return { comment: commentPayload };
  }

  /**
   * PATCH /api/v1/manuscripts/pages/:pageId/comments/:commentId/replies/:replyId
   * PATCH /api/v1/manuscripts/docs/:pageId/comments/:commentId/replies/:replyId
   * PATCH /api/v1/manuscripts/projects/:projectId/docs/:pageId/comments/:commentId/replies/:replyId
   */
  @Patch([
    'pages/:pageId/comments/:commentId/replies/:replyId',
    'docs/:pageId/comments/:commentId/replies/:replyId',
    'spaces/:spaceId/docs/:pageId/comments/:commentId/replies/:replyId',
  ])
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  async updateCommentReply(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
    @Body() body: { content: string },
    @Param('spaceId') routeProjectId?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
    @CurrentRole() role?: Role,
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

    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDocAndProject(
        pageId,
        routeProjectId || authorizedProjectId,
      );
    const userId = req?.user?.id || req?.user?.sub;

    if (!targetProjectId) {
      throw new NotFoundException(`Reply ${replyId} not found`);
    }

    const existingThread = await this.pageScopeRepo.findThreadInProject(
      targetProjectId,
      commentId,
      resolvedDocId,
    );
    const existingReply = existingThread?.replies?.find(
      (r) => r.id === replyId,
    );

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

    const reqCtx = req as
      { projectMember?: { permissionBitmask?: string } } | undefined;
    if (existingReply.createdById) {
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

    if (typeof this.pageScopeRepo.updateReplyInThread === 'function') {
      await this.pageScopeRepo.updateReplyInThread(
        existingThread.id,
        replyId,
        trimmed,
      );
    } else if (this.trackChangesRepo?.updateCommentReply) {
      await this.trackChangesRepo.updateCommentReply(
        existingThread.id,
        replyId,
        trimmed,
      );
    }

    const updatedThread = await this.pageScopeRepo.findThreadInProject(
      targetProjectId,
      commentId,
    );
    let commentPayload = null;
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

    this.broadcastEvent(targetProjectId, 'comment:reply-updated', {
      docId: existingThread.docId,
      commentId: existingThread.id,
      replyId,
      comment: commentPayload,
    });

    return { comment: commentPayload };
  }

  /**
   * DELETE /api/v1/manuscripts/pages/:pageId/comments/:commentId/replies/:replyId
   * DELETE /api/v1/manuscripts/docs/:pageId/comments/:commentId/replies/:replyId
   * DELETE /api/v1/manuscripts/projects/:projectId/docs/:pageId/comments/:commentId/replies/:replyId
   */
  @Delete([
    'pages/:pageId/comments/:commentId/replies/:replyId',
    'docs/:pageId/comments/:commentId/replies/:replyId',
    'spaces/:spaceId/docs/:pageId/comments/:commentId/replies/:replyId',
  ])
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  async deleteCommentReply(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
    @Param('spaceId') routeProjectId?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    if (!isUuid(replyId) || !isUuid(commentId)) {
      throw new BadRequestException(
        'Valid UUIDs are required for commentId and replyId',
      );
    }

    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDocAndProject(
        pageId,
        routeProjectId || authorizedProjectId,
      );
    const userId = req?.user?.id || req?.user?.sub;

    if (!targetProjectId) {
      throw new NotFoundException(`Reply ${replyId} not found`);
    }

    const existingThread = await this.pageScopeRepo.findThreadInProject(
      targetProjectId,
      commentId,
      resolvedDocId,
    );
    const existingReply = existingThread?.replies?.find(
      (r) => r.id === replyId,
    );

    if (!existingThread || !existingReply) {
      throw new NotFoundException(`Reply ${replyId} not found`);
    }

    const reqCtx = req as
      { projectMember?: { permissionBitmask?: string } } | undefined;
    if (userId || role) {
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
    'spaces/:spaceId/docs/:pageId/comments/:commentId/resolve',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  async resolveComment(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Body() body: { resolved?: boolean },
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
    @CurrentUser('id') currentUserId?: string,
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
      currentUserId,
      ...(updated.replies || []).map((r) => r.createdById),
    ]);
    const commentPayload = formatCommentThreadDto(updated, userMap);

    this.broadcastEvent(this.getRecordSpaceId(updated), 'comment:resolved', {
      docId: updated.docId,
      commentId: updated.id,
      resolved: isResolved,
      comment: commentPayload,
    });

    if (this.pagesNotifications) {
      await this.dispatchReviewNotificationSafe('resolveComment', async () => {
        if (!isResolved) {
          await this.pagesNotifications?.dismissThreadResolved(updated.id);
          return;
        }
        if (
          currentUserId &&
          isUuid(currentUserId) &&
          updated.createdById &&
          updated.createdById !== currentUserId
        ) {
          const ctx = await this.resolveSpaceNotificationContext(
            this.getRecordSpaceId(updated) || targetProjectId,
            (updated as { pageId?: string | null }).pageId,
            updated.docId,
          );
          const actorName = userMap.get(currentUserId)?.name || 'Collaborator';
          await this.pagesNotifications?.notifyThreadResolved({
            recipientUserId: updated.createdById,
            actorId: currentUserId,
            actorName,
            spaceId: ctx.spaceId,
            projectId: ctx.projectId,
            projectName: ctx.projectName,
            pageId: ctx.pageId,
            docId: updated.docId,
            threadId: updated.id,
            quote: updated.quote || undefined,
            isPersonalSpace: ctx.isPersonalSpace,
          });
        }
      });
    }

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
    'spaces/:spaceId/docs/:pageId/suggestions',
  ])
  async getSuggestions(
    @Param('pageId') pageId: string,
    @Query('status') status?: 'pending' | 'accepted' | 'rejected',
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) return { suggestions: [] };
    try {
      const { docId: resolvedDocId, projectId: resolvedProj } =
        await this.resolveDocAndProject(
          pageId,
          routeProjectId || authorizedProjectId,
        );
      const targetProjectId =
        resolvedProj ||
        this.resolveActiveProjectId(authorizedProjectId) ||
        routeProjectId;
      const targetDocId = resolvedDocId || pageId;
      if (!targetProjectId || !this.trackChangesRepo) {
        return { suggestions: [] };
      }

      const domainChanges = await this.trackChangesRepo.listChangesByDoc(
        targetProjectId,
        targetDocId,
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
          fromLine: s.range.startLine + 1,
          fromColumn: s.range.startCol,
          toLine: s.range.endLine + 1,
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
    'spaces/:spaceId/docs/:pageId/suggestions',
  ])
  @HttpCode(HttpStatus.CREATED)
  async createSuggestion(
    @Param('pageId') pageId: string,
    @Body() body: CreateSuggestionBody,
    @Req() req: AuthenticatedRequest,
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    const activeProj =
      this.resolveActiveProjectId(authorizedProjectId) || routeProjectId;
    const {
      docId: resolvedDocId,
      projectId: docProjId,
      pageId: resolvedPageId,
    } = await this.resolveDocAndProject(pageId, activeProj || body?.spaceId);
    const resolvedProj =
      docProjId ||
      activeProj ||
      body?.spaceId ||
      (await this.pageService.resolveProjectId(pageId));
    const targetDocId = resolvedDocId || pageId;
    if (!resolvedProj || !isUuid(resolvedProj) || !isUuid(targetDocId)) {
      throw new BadRequestException(
        'Valid pageId and associated project required to create a suggestion',
      );
    }

    const type: PageChangeType =
      body.type === 'delete' ? PageChangeType.delete : PageChangeType.insert;
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
      spaceId: resolvedProj,
      pageId: resolvedPageId ?? null,
      docId: targetDocId,
      type: type === PageChangeType.delete ? 'delete' : 'insert',
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
      pageId: targetDocId,
      page: targetDocId,
      projectPageId: targetDocId,
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
      fromLine: saved.range.startLine + 1,
      fromColumn: saved.range.startCol,
      toLine: saved.range.endLine + 1,
      toColumn: saved.range.endCol,
      status: saved.status,
      createdAt: saved.createdAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
    };

    this.broadcastEvent(resolvedProj, 'track-changes:created', {
      docId: targetDocId,
      suggestion: suggestionPayload,
    });

    if (this.pagesNotifications && userId && isUuid(userId)) {
      await this.dispatchReviewNotificationSafe(
        'createSuggestion',
        async () => {
          const ctx = await this.resolveSpaceNotificationContext(
            resolvedProj,
            resolvedPageId,
            targetDocId,
          );
          if (ctx.fallbackOwnerId && ctx.fallbackOwnerId !== userId) {
            await this.pagesNotifications?.notifyReviewSuggestion({
              recipientUserId: ctx.fallbackOwnerId,
              actorId: userId,
              actorName: authorName,
              spaceId: ctx.spaceId,
              projectId: ctx.projectId,
              projectName: ctx.projectName,
              pageId: ctx.pageId,
              docId: targetDocId,
              changeId: saved.id,
              changeType: saved.type === 'delete' ? 'delete' : 'insert',
              snippet: text,
              line: saved.range.startLine + 1,
              isPersonalSpace: ctx.isPersonalSpace,
            });
          }
          if (text && text.includes('@')) {
            await this.pagesNotifications?.parseAndNotifyMentions({
              text,
              actorId: userId,
              actorName: authorName,
              spaceId: ctx.spaceId,
              projectId: ctx.projectId,
              projectName: ctx.projectName,
              pageId: ctx.pageId,
              docId: targetDocId,
              isPersonalSpace: ctx.isPersonalSpace,
              collaboratorMap: ctx.collaboratorMap,
            });
          }
        },
      );
    }

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
    'spaces/:spaceId/docs/:pageId/suggestions/:suggestionId/accept',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async acceptSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
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
      const userMap = await this.resolveUserNames([
        existing.createdById,
        userId,
      ]);
      const formatted = formatSuggestionItemDto(existing, userMap);
      return { ok: true, suggestion: { ...existing, ...formatted } };
    }

    const resolvedById = isUuid(userId) ? userId : null;
    if (typeof this.pageScopeRepo.claimTrackChangesPending === 'function') {
      const claimed = await this.pageScopeRepo.claimTrackChangesPending(
        targetProjectId,
        [suggestionId],
        'accepted',
        resolvedById,
        resolvedDocId,
      );
      if (claimed.length === 0) {
        const latest =
          (await this.pageScopeRepo.findTrackChangeInProject(
            targetProjectId,
            suggestionId,
          )) ?? existing;
        const userMap = await this.resolveUserNames([
          latest.createdById,
          userId,
        ]);
        const formatted = formatSuggestionItemDto(latest, userMap);
        return { ok: true, suggestion: { ...latest, ...formatted } };
      }
    } else {
      await this.pageScopeRepo.updateTrackChangeInProject(
        targetProjectId,
        suggestionId,
        {
          status: 'accepted',
          resolvedAt: new Date(),
          resolvedById,
        },
      );
    }

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
          const docProjectId = this.getRecordSpaceId(doc) || targetProjectId;
          const lines = await this.pageService.getHydratedDocLines(doc);
          const { LinePatcher } =
            await import('@/modules/pages/track-changes/domain');
          const changeEntity = TrackChange.create({
            id: record.id,
            projectId: docProjectId,
            docId: doc.id,
            type: record.type === 'delete' ? 'delete' : 'insert',
            text: record.text,
            range: TextRangeVo.create({
              startLine: Math.max(0, record.startLine ?? 0),
              startCol: Math.max(0, record.startCol ?? 0),
              endLine: Math.max(0, record.endLine ?? record.startLine ?? 0),
              endCol: Math.max(0, record.endCol ?? 0),
            }),
            createdById: record.createdById,
          });
          const { lines: nextLines, mutated } =
            LinePatcher.computeAcceptedPatch(lines, changeEntity);

          let finalVersion = doc.version;
          let finalRev = doc.rev;
          if (mutated) {
            const updateRes = await this.docstoreService.updateDoc(
              docProjectId,
              doc.id,
              {
                lines: nextLines,
                version: doc.version + 1,
                expectedRev: doc.rev,
              },
            );
            finalVersion = updateRes?.doc?.version ?? doc.version + 1;
            finalRev = updateRes?.rev ?? updateRes?.doc?.rev ?? doc.rev + 1;

            await this.syncLiveDoc(docProjectId, doc.id, nextLines);
          }

          updatedPage = {
            id: doc.id,
            content: nextLines.join('\n'),
            version: finalVersion,
            rev: finalRev,
            projectId: docProjectId,
          };

          this.broadcastEvent(docProjectId, 'track-changes:resolved', {
            docId: doc.id,
            change: record,
            action: 'accepted',
            resolvedById,
          });
        }
      } catch (applyErr) {
        this.logger.error(
          `Failed to apply accepted suggestion ${suggestionId} to docstore, rolling back status: ${applyErr}`,
        );
        if (
          typeof this.pageScopeRepo.revertClaimedTrackChanges === 'function'
        ) {
          await this.pageScopeRepo.revertClaimedTrackChanges(
            targetProjectId,
            [suggestionId],
            'accepted',
          );
        } else {
          await this.pageScopeRepo.updateTrackChangeInProject(
            targetProjectId,
            suggestionId,
            { status: 'pending', resolvedAt: null, resolvedById: null },
          );
        }
        if (applyErr instanceof StaleTrackChangeAnchorException) {
          throw new ConflictException({
            statusCode: 409,
            code: applyErr.code,
            message: applyErr.message,
          });
        }
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
    'spaces/:spaceId/docs/:pageId/suggestions/:suggestionId/reject',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async rejectSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
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
      const userMap = await this.resolveUserNames([
        existing.createdById,
        userId,
      ]);
      const formatted = formatSuggestionItemDto(existing, userMap);
      return { ok: true, suggestion: { ...existing, ...formatted } };
    }

    const resolvedById = isUuid(userId) ? userId : null;
    if (typeof this.pageScopeRepo.claimTrackChangesPending === 'function') {
      const claimed = await this.pageScopeRepo.claimTrackChangesPending(
        targetProjectId,
        [suggestionId],
        'rejected',
        resolvedById,
        resolvedDocId,
      );
      if (claimed.length === 0) {
        const latest =
          (await this.pageScopeRepo.findTrackChangeInProject(
            targetProjectId,
            suggestionId,
          )) ?? existing;
        const userMap = await this.resolveUserNames([
          latest.createdById,
          userId,
        ]);
        const formatted = formatSuggestionItemDto(latest, userMap);
        return { ok: true, suggestion: { ...latest, ...formatted } };
      }
    } else {
      await this.pageScopeRepo.updateTrackChangeInProject(
        targetProjectId,
        suggestionId,
        {
          status: 'rejected',
          resolvedAt: new Date(),
          resolvedById,
        },
      );
    }

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
          const docProjectId = this.getRecordSpaceId(doc) || targetProjectId;
          const lines = await this.pageService.getHydratedDocLines(doc);
          const { LinePatcher } =
            await import('@/modules/pages/track-changes/domain');
          const changeEntity = TrackChange.create({
            id: record.id,
            projectId: docProjectId,
            docId: doc.id,
            type: record.type === 'delete' ? 'delete' : 'insert',
            text: record.text,
            range: TextRangeVo.create({
              startLine: Math.max(0, record.startLine ?? 0),
              startCol: Math.max(0, record.startCol ?? 0),
              endLine: Math.max(0, record.endLine ?? record.startLine ?? 0),
              endCol: Math.max(0, record.endCol ?? 0),
            }),
            createdById: record.createdById,
          });
          const { lines: nextLines, mutated } =
            LinePatcher.computeRejectedPatch(lines, changeEntity);

          let finalVersion = doc.version;
          let finalRev = doc.rev;
          if (mutated) {
            const updateRes = await this.docstoreService.updateDoc(
              docProjectId,
              doc.id,
              {
                lines: nextLines,
                version: doc.version + 1,
                expectedRev: doc.rev,
              },
            );
            finalVersion = updateRes?.doc?.version ?? doc.version + 1;
            finalRev = updateRes?.rev ?? updateRes?.doc?.rev ?? doc.rev + 1;

            await this.syncLiveDoc(docProjectId, doc.id, nextLines);
          }

          updatedPage = {
            id: doc.id,
            content: nextLines.join('\n'),
            version: finalVersion,
            rev: finalRev,
            projectId: docProjectId,
          };
        }
      } catch (revertErr) {
        this.logger.error(
          `Failed to revert rejected suggestion ${suggestionId} in docstore, rolling back status: ${revertErr}`,
        );
        if (
          typeof this.pageScopeRepo.revertClaimedTrackChanges === 'function'
        ) {
          await this.pageScopeRepo.revertClaimedTrackChanges(
            targetProjectId,
            [suggestionId],
            'rejected',
          );
        } else {
          await this.pageScopeRepo.updateTrackChangeInProject(
            targetProjectId,
            suggestionId,
            { status: 'pending', resolvedAt: null, resolvedById: null },
          );
        }
        if (revertErr instanceof StaleTrackChangeAnchorException) {
          throw new ConflictException({
            statusCode: 409,
            code: revertErr.code,
            message: revertErr.message,
          });
        }
        throw revertErr;
      }

      this.broadcastEvent(targetProjectId, 'track-changes:resolved', {
        docId: record.docId,
        change: record,
        action: 'rejected',
        resolvedById,
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
   * POST /api/v1/manuscripts/projects/:projectId/docs/:pageId/suggestions/accept-all
   */
  @Post([
    'pages/:pageId/suggestions/accept-all',
    'docs/:pageId/suggestions/accept-all',
    'spaces/:spaceId/docs/:pageId/suggestions/accept-all',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async acceptAllSuggestions(
    @Param('pageId') pageId: string,
    @Body() body: { suggestionIds?: string[] },
    @ResolvedSpace() authorizedProjectId: string | { id: string } | null,
    @Param('spaceId') routeProjectId?: string,
    @Req() req?: AuthenticatedRequest,
  ) {
    const resolvedCount = await this.batchResolvePageSuggestions(
      pageId,
      routeProjectId || authorizedProjectId,
      true,
      body?.suggestionIds,
      req?.user?.id || req?.user?.sub || null,
    );
    return { ok: true, acceptedCount: resolvedCount, resolvedCount };
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/suggestions/reject-all
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/reject-all
   * POST /api/v1/manuscripts/projects/:projectId/docs/:pageId/suggestions/reject-all
   */
  @Post([
    'pages/:pageId/suggestions/reject-all',
    'docs/:pageId/suggestions/reject-all',
    'spaces/:spaceId/docs/:pageId/suggestions/reject-all',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async rejectAllSuggestions(
    @Param('pageId') pageId: string,
    @Body() body: { suggestionIds?: string[] },
    @ResolvedSpace() authorizedProjectId: string | { id: string } | null,
    @Param('spaceId') routeProjectId?: string,
    @Req() req?: AuthenticatedRequest,
  ) {
    const resolvedCount = await this.batchResolvePageSuggestions(
      pageId,
      routeProjectId || authorizedProjectId,
      false,
      body?.suggestionIds,
      req?.user?.id || req?.user?.sub || null,
    );
    return { ok: true, rejectedCount: resolvedCount, resolvedCount };
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/suggestions/batch-resolve
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/batch-resolve
   * POST /api/v1/manuscripts/projects/:projectId/docs/:pageId/suggestions/batch-resolve
   */
  @Post([
    'pages/:pageId/suggestions/batch-resolve',
    'docs/:pageId/suggestions/batch-resolve',
    'spaces/:spaceId/docs/:pageId/suggestions/batch-resolve',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async batchResolveSuggestions(
    @Param('pageId') pageId: string,
    @Body()
    body: {
      action: 'accept' | 'reject' | 'accept_all' | 'reject_all';
      suggestionIds?: string[];
    },
    @ResolvedSpace() authorizedProjectId: string | { id: string } | null,
    @Param('spaceId') routeProjectId?: string,
    @Req() req?: AuthenticatedRequest,
  ) {
    const isAccept = body?.action === 'accept' || body?.action === 'accept_all';
    const resolvedCount = await this.batchResolvePageSuggestions(
      pageId,
      routeProjectId || authorizedProjectId,
      isAccept,
      body?.suggestionIds,
      req?.user?.id || req?.user?.sub || null,
    );
    return {
      ok: true,
      action: isAccept ? 'accept' : 'reject',
      resolvedCount,
      acceptedCount: isAccept ? resolvedCount : 0,
      rejectedCount: isAccept ? 0 : resolvedCount,
    };
  }

  /**
   * GET /api/v1/manuscripts/projects/:projectId/review-overview
   * GET /api/v1/manuscripts/pages/:projectId/review-overview
   * GET /api/v1/manuscripts/docs/:projectId/review-overview
   */
  @Get([
    'spaces/:spaceId/review-overview',
    'pages/:projectId/review-overview',
    'docs/:projectId/review-overview',
  ])
  @RequireRole(Role.REVIEWER)
  async getProjectReviewOverview(
    @Param('spaceId') routeProjectId: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    const resolvedActive = this.resolveActiveProjectId(authorizedProjectId);
    const targetProjectId =
      resolvedActive ||
      (isUuid(routeProjectId)
        ? (await this.pageService.resolveProjectId(routeProjectId)) ||
          routeProjectId
        : routeProjectId);

    if (!targetProjectId || !isUuid(targetProjectId)) {
      return {
        projectId: targetProjectId || routeProjectId,
        files: [],
        totals: {
          openCommentsCount: 0,
          resolvedCommentsCount: 0,
          pendingSuggestionsCount: 0,
          acceptedSuggestionsCount: 0,
          rejectedSuggestionsCount: 0,
          totalVisibleCount: 0,
          totalResolvedCount: 0,
        },
      };
    }

    const reqPageId = (req as { resolvedPageId?: string } | undefined)
      ?.resolvedPageId;
    const explicitPageId =
      reqPageId ??
      (isUuid(routeProjectId) &&
      resolvedActive &&
      routeProjectId !== resolvedActive
        ? routeProjectId
        : undefined);

    return buildProjectReviewOverview({
      pageScopeRepo: this.pageScopeRepo,
      projectId: targetProjectId,
      pageId: explicitPageId,
      resolveUserNames: (userIds) => this.resolveUserNames(userIds),
    });
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

    const resolvedStatus = isAccept ? 'accepted' : 'rejected';
    const resolvedById = isUuid(userId) ? userId : null;
    const useAtomicClaim =
      typeof this.pageScopeRepo.claimTrackChangesPending === 'function';

    let targetChanges = filtered;
    let claimedIds: string[] = [];
    if (useAtomicClaim) {
      claimedIds = await this.pageScopeRepo.claimTrackChangesPending(
        targetProjectId,
        filtered.map((c) => c.id),
        resolvedStatus,
        resolvedById,
        docId,
      );
      if (claimedIds.length === 0) {
        return 0;
      }
      const claimedSet = new Set(claimedIds);
      targetChanges = filtered.filter((c) => claimedSet.has(c.id));
    }

    const normalizedChanges = targetChanges.map((c) =>
      TrackChange.create({
        id: c.id,
        projectId: c.projectId,
        docId: c.docId,
        type: c.type,
        text: c.text,
        range: TextRangeVo.create({
          startLine: Math.max(0, c.range.startLine),
          startCol: Math.max(0, c.range.startCol),
          endLine: Math.max(0, c.range.endLine),
          endCol: Math.max(0, c.range.endCol),
        }),
        createdById: c.createdById,
      }),
    );

    const { LinePatcher } =
      await import('@/modules/pages/track-changes/domain');
    const sorted = LinePatcher.sortChangesBottomUp(normalizedChanges);

    try {
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
          const docProjectId = this.getRecordSpaceId(doc) || targetProjectId;
          await this.docstoreService.updateDoc(docProjectId, doc.id, {
            lines: currentLines,
            version: doc.version + 1,
            expectedRev: doc.rev,
          });
          await this.syncLiveDoc(docProjectId, doc.id, currentLines);
        }
      }

      if (!useAtomicClaim) {
        const now = new Date();
        await this.trackChangesRepo.batchUpdateChangesStatus(
          sorted.map((c) => c.id),
          resolvedStatus,
          resolvedById,
          now,
          targetProjectId,
          docId,
        );
      }
    } catch (batchErr) {
      if (
        useAtomicClaim &&
        claimedIds.length > 0 &&
        typeof this.pageScopeRepo.revertClaimedTrackChanges === 'function'
      ) {
        await this.pageScopeRepo
          .revertClaimedTrackChanges(
            targetProjectId,
            claimedIds,
            resolvedStatus,
          )
          .catch(() => undefined);
      }
      if (batchErr instanceof StaleTrackChangeAnchorException) {
        throw new ConflictException({
          statusCode: 409,
          code: batchErr.code,
          message: batchErr.message,
        });
      }
      throw batchErr;
    }

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
    'spaces/:spaceId/docs/:pageId/review-status',
  ])
  @RequireRole(Role.REVIEWER)
  async getReviewStatus(
    @Param('pageId') pageId: string,
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
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
    'spaces/:spaceId/docs/:pageId/review-status',
  ])
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  async updateReviewStatus(
    @Param('pageId') pageId: string,
    @Body() body: UpdateReviewStatusDto,
    @ResolvedSpace() authorizedProjectId: string | { id: string } | null,
    @CurrentRole() currentRole: Role,
    @Param('spaceId') routeProjectId?: string,
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

/** @deprecated Use ReviewController */
export { ReviewController as PagesReviewController };
