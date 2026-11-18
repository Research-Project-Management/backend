/**
 * track-changes/track-changes.controller.ts
 * REST API Controller for Review Mode (Track Changes & Inline Comments).
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Req,
  Optional,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedSpace,
  CurrentRole,
} from '@/modules/project/access';
import { TrackChangesService } from './track-changes.service';
import {
  RecordChangeDto,
  BatchResolveDto,
  CreateCommentThreadDto,
  AddCommentReplyDto,
  ResolveThreadDto,
  TrackChangeResponseDto,
  CommentThreadResponseDto,
  CommentReplyResponseDto,
  DocReviewsResponseDto,
} from './dto/track-changes.dto';
import {
  ChangeNotFoundException,
  ThreadNotFoundException,
  ResolvedThreadException,
  StaleTrackChangeAnchorException,
  CommentThreadDomainException,
  TrackChangeDomainException,
  InvalidCommentReplyException,
} from './domain';
import { AuthenticatedRequest, PrismaService } from '@/core';
import { resolvePageControllerCoordinates } from '@/modules/pages/core/page-scope.helper';

@ApiTags('Manuscripts - Review Mode (Track Changes & Comments)')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/pages/spaces/:spaceId/docs/:docId/review',
  'api/v1/pages/pages/:pageId/docs/:docId/review',
  'api/v1/pages/pages/:pageId/review',
  'api/v1/pages/docs/:docId/review',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class TrackChangesController {
  constructor(
    private readonly trackChangesService: TrackChangesService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  private async resolveReviewCoordinates(
    req: AuthenticatedRequest | undefined,
    spaceIdParam?: string,
    pageIdParam?: string,
    docIdParam?: string,
    authorizedSpace?: string | { id?: string } | null,
  ): Promise<{ projectId: string; docId: string }> {
    const coords = resolvePageControllerCoordinates(
      {
        spaceId: spaceIdParam,
        pageId: pageIdParam,
        docId: docIdParam,
      },
      authorizedSpace,
      undefined,
      req,
    );

    let resolvedDocId = docIdParam?.trim() || '';
    let resolvedSpaceId = coords.spaceId;

    if (
      !resolvedDocId &&
      pageIdParam?.trim() &&
      this.prisma?.page?.findUnique
    ) {
      const page = await Promise.resolve(
        this.prisma.page.findUnique({
          where: { id: pageIdParam.trim() },
          select: { spaceId: true, rootDocId: true, deletedAt: true },
        }),
      ).catch(() => null);
      if (page && !page.deletedAt) {
        if (page.spaceId) resolvedSpaceId = page.spaceId;
        if (page.rootDocId) resolvedDocId = page.rootDocId;
      }
      if (!resolvedDocId && this.prisma?.pageNode?.findFirst) {
        const rootNode = await Promise.resolve(
          this.prisma.pageNode.findFirst({
            where: {
              pageId: pageIdParam.trim(),
              type: 'DOC',
              ...(resolvedSpaceId ? { spaceId: resolvedSpaceId } : {}),
            },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            select: { docId: true, spaceId: true },
          }),
        ).catch(() => null);
        if (rootNode?.docId) {
          resolvedDocId = rootNode.docId;
          if (!resolvedSpaceId && rootNode.spaceId) {
            resolvedSpaceId = rootNode.spaceId;
          }
        }
      }
    }

    if (!resolvedDocId) {
      throw new NotFoundException(
        `Could not resolve document for review request.`,
      );
    }

    if (!resolvedSpaceId) {
      resolvedSpaceId = await this.trackChangesService.resolveProjectId(
        '',
        resolvedDocId,
      );
    }

    return { projectId: resolvedSpaceId, docId: resolvedDocId };
  }

  private handleError(error: unknown): never {
    if (
      error instanceof ChangeNotFoundException ||
      error instanceof ThreadNotFoundException
    ) {
      throw new NotFoundException(error.message);
    }
    if (
      error instanceof StaleTrackChangeAnchorException ||
      error instanceof ResolvedThreadException
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: error.code,
        message: error.message,
      });
    }
    if (
      error instanceof CommentThreadDomainException ||
      error instanceof TrackChangeDomainException ||
      error instanceof InvalidCommentReplyException
    ) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  @Get()
  @ApiOperation({
    summary: 'Get all track changes and comment threads for a document',
  })
  @ApiResponse({ status: 200, type: DocReviewsResponseDto })
  async getDocReviews(
    @Param('spaceId') spaceIdParam?: string,
    @Param('pageId') pageIdParam?: string,
    @Param('docId') docIdParam?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpace?: string | { id?: string } | null,
  ): Promise<DocReviewsResponseDto> {
    try {
      const { projectId, docId } = await this.resolveReviewCoordinates(
        req,
        spaceIdParam,
        pageIdParam,
        docIdParam,
        authorizedSpace,
      );
      return await this.trackChangesService.getDocReviews(projectId, docId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get(['threads', 'comments'])
  @ApiOperation({
    summary: 'Get all comment threads for a document',
  })
  @ApiResponse({ status: 200, type: [CommentThreadResponseDto] })
  async getDocThreads(
    @Param('spaceId') spaceIdParam?: string,
    @Param('pageId') pageIdParam?: string,
    @Param('docId') docIdParam?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpace?: string | { id?: string } | null,
  ): Promise<CommentThreadResponseDto[]> {
    try {
      const { projectId, docId } = await this.resolveReviewCoordinates(
        req,
        spaceIdParam,
        pageIdParam,
        docIdParam,
        authorizedSpace,
      );
      const reviews = await this.trackChangesService.getDocReviews(
        projectId,
        docId,
      );
      return reviews.threads;
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('changes')
  @ApiOperation({
    summary: 'Get all pending track changes for a document',
  })
  @ApiResponse({ status: 200, type: [TrackChangeResponseDto] })
  async getDocChanges(
    @Param('spaceId') spaceIdParam?: string,
    @Param('pageId') pageIdParam?: string,
    @Param('docId') docIdParam?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpace?: string | { id?: string } | null,
  ): Promise<TrackChangeResponseDto[]> {
    try {
      const { projectId, docId } = await this.resolveReviewCoordinates(
        req,
        spaceIdParam,
        pageIdParam,
        docIdParam,
        authorizedSpace,
      );
      const reviews = await this.trackChangesService.getDocReviews(
        projectId,
        docId,
      );
      return reviews.changes;
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('changes')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Record a new proposed inline text mutation (insert or delete)',
  })
  @ApiResponse({ status: 201, type: TrackChangeResponseDto })
  async recordChange(
    @Body() dto: RecordChangeDto,
    @Param('spaceId') spaceIdParam?: string,
    @Param('pageId') pageIdParam?: string,
    @Param('docId') docIdParam?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpace?: string | { id?: string } | null,
  ): Promise<TrackChangeResponseDto> {
    try {
      const { projectId, docId } = await this.resolveReviewCoordinates(
        req,
        spaceIdParam,
        pageIdParam,
        docIdParam,
        authorizedSpace,
      );
      const userId = req?.user?.id || req?.user?.sub || null;
      return await this.trackChangesService.recordChange(
        projectId,
        docId,
        dto,
        userId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('changes/:changeId/accept')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Accept a proposed change (merges text permanently into Docstore)',
  })
  @ApiResponse({ status: 200, type: TrackChangeResponseDto })
  async acceptChange(
    @Param('changeId') changeId: string,
    @Param('spaceId') spaceIdParam?: string,
    @Param('pageId') pageIdParam?: string,
    @Param('docId') docIdParam?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpace?: string | { id?: string } | null,
  ): Promise<TrackChangeResponseDto> {
    try {
      const { projectId, docId } = await this.resolveReviewCoordinates(
        req,
        spaceIdParam,
        pageIdParam,
        docIdParam,
        authorizedSpace,
      );
      const userId = req?.user?.id || req?.user?.sub || null;
      return await this.trackChangesService.acceptChange(
        projectId,
        docId,
        changeId,
        userId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('changes/:changeId/reject')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Reject a proposed change (reverts text in Docstore)',
  })
  @ApiResponse({ status: 200, type: TrackChangeResponseDto })
  async rejectChange(
    @Param('changeId') changeId: string,
    @Param('spaceId') spaceIdParam?: string,
    @Param('pageId') pageIdParam?: string,
    @Param('docId') docIdParam?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpace?: string | { id?: string } | null,
  ): Promise<TrackChangeResponseDto> {
    try {
      const { projectId, docId } = await this.resolveReviewCoordinates(
        req,
        spaceIdParam,
        pageIdParam,
        docIdParam,
        authorizedSpace,
      );
      const userId = req?.user?.id || req?.user?.sub || null;
      return await this.trackChangesService.rejectChange(
        projectId,
        docId,
        changeId,
        userId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('changes/batch')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Bulk accept or reject all pending changes in a document',
  })
  @ApiResponse({ status: 200 })
  async batchResolveChanges(
    @Body() dto: BatchResolveDto,
    @Param('spaceId') spaceIdParam?: string,
    @Param('pageId') pageIdParam?: string,
    @Param('docId') docIdParam?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpace?: string | { id?: string } | null,
  ) {
    try {
      const { projectId, docId } = await this.resolveReviewCoordinates(
        req,
        spaceIdParam,
        pageIdParam,
        docIdParam,
        authorizedSpace,
      );
      const userId = req?.user?.id || req?.user?.sub || null;
      return await this.trackChangesService.batchResolveChanges(
        projectId,
        docId,
        dto.action,
        dto.changeIds,
        userId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post(['threads', 'comments'])
  @ApiOperation({
    summary: 'Create an inline comment thread pinned to text coordinates',
  })
  @ApiResponse({ status: 201, type: CommentThreadResponseDto })
  async createCommentThread(
    @Body() dto: CreateCommentThreadDto,
    @Param('spaceId') spaceIdParam?: string,
    @Param('pageId') pageIdParam?: string,
    @Param('docId') docIdParam?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpace?: string | { id?: string } | null,
  ): Promise<CommentThreadResponseDto> {
    try {
      const { projectId, docId } = await this.resolveReviewCoordinates(
        req,
        spaceIdParam,
        pageIdParam,
        docIdParam,
        authorizedSpace,
      );
      const userId = req?.user?.id || req?.user?.sub || null;
      return await this.trackChangesService.createCommentThread(
        projectId,
        docId,
        dto,
        userId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post(['threads/:threadId/replies', 'comments/:threadId/replies'])
  @ApiOperation({ summary: 'Reply to an active comment thread' })
  @ApiResponse({ status: 201, type: CommentReplyResponseDto })
  async addCommentReply(
    @Param('threadId') threadId: string,
    @Body() dto: AddCommentReplyDto,
    @Param('spaceId') spaceIdParam?: string,
    @Param('pageId') pageIdParam?: string,
    @Param('docId') docIdParam?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpace?: string | { id?: string } | null,
  ): Promise<CommentReplyResponseDto> {
    try {
      const { projectId, docId } = await this.resolveReviewCoordinates(
        req,
        spaceIdParam,
        pageIdParam,
        docIdParam,
        authorizedSpace,
      );
      const userId = req?.user?.id || req?.user?.sub || null;
      return await this.trackChangesService.addCommentReply(
        projectId,
        docId,
        threadId,
        dto,
        userId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Patch([
    'threads/:threadId/replies/:replyId',
    'comments/:threadId/replies/:replyId',
  ])
  @RequireRole(Role.REVIEWER)
  @ApiOperation({ summary: 'Edit a comment reply as its original author' })
  @ApiResponse({ status: 200, type: CommentReplyResponseDto })
  async updateCommentReply(
    @Param('threadId') threadId: string,
    @Param('replyId') replyId: string,
    @Body() dto: AddCommentReplyDto,
    @Param('spaceId') spaceIdParam?: string,
    @Param('pageId') pageIdParam?: string,
    @Param('docId') docIdParam?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpace?: string | { id?: string } | null,
    @CurrentRole() role?: Role,
  ): Promise<CommentReplyResponseDto> {
    try {
      const { projectId, docId } = await this.resolveReviewCoordinates(
        req,
        spaceIdParam,
        pageIdParam,
        docIdParam,
        authorizedSpace,
      );
      const userId = req?.user?.id || req?.user?.sub || null;
      const reqCtx = req as
        { projectMember?: { permissionBitmask?: string } } | undefined;
      return await this.trackChangesService.updateCommentReply(
        projectId,
        docId,
        threadId,
        replyId,
        dto.content,
        userId,
        role,
        reqCtx?.projectMember?.permissionBitmask,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Patch(['threads/:threadId/resolve', 'comments/:threadId/resolve'])
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Resolve or reopen a comment thread' })
  @ApiResponse({ status: 200, type: CommentThreadResponseDto })
  async resolveCommentThread(
    @Param('threadId') threadId: string,
    @Body() dto: ResolveThreadDto,
    @Param('spaceId') spaceIdParam?: string,
    @Param('pageId') pageIdParam?: string,
    @Param('docId') docIdParam?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpace?: string | { id?: string } | null,
  ): Promise<CommentThreadResponseDto> {
    try {
      const { projectId, docId } = await this.resolveReviewCoordinates(
        req,
        spaceIdParam,
        pageIdParam,
        docIdParam,
        authorizedSpace,
      );
      const userId = req?.user?.id || req?.user?.sub || null;
      return await this.trackChangesService.resolveCommentThread(
        projectId,
        docId,
        threadId,
        dto.resolve,
        userId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }
}
