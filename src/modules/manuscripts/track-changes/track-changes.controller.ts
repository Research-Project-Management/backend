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
  NotFoundException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
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
import { ChangeNotFoundException } from './core/domain/exceptions/change-not-found.exception';
import { ThreadNotFoundException } from './core/domain/exceptions/thread-not-found.exception';
import { ResolvedThreadException } from './core/domain/exceptions/resolved-thread.exception';

@ApiTags('Manuscripts - Review Mode (Track Changes & Comments)')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/manuscripts/projects/:projectId/docs/:docId/review',
  'v1/manuscripts/projects/:projectId/docs/:docId/review',
  'manuscripts/projects/:projectId/docs/:docId/review',
  'projects/:projectId/docs/:docId/review',
])
@UseGuards(JwtAuthGuard)
export class TrackChangesController {
  constructor(private readonly trackChangesService: TrackChangesService) {}

  private handleError(error: any): never {
    if (
      error instanceof ChangeNotFoundException ||
      error instanceof ThreadNotFoundException
    ) {
      throw new NotFoundException(error.message);
    }
    if (error instanceof ResolvedThreadException) {
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
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
  ): Promise<DocReviewsResponseDto> {
    try {
      return await this.trackChangesService.getDocReviews(projectId, docId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('changes')
  @ApiOperation({
    summary: 'Record a new proposed inline text mutation (insert or delete)',
  })
  @ApiResponse({ status: 201, type: TrackChangeResponseDto })
  async recordChange(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Body() dto: RecordChangeDto,
    @Req() req?: any,
  ): Promise<TrackChangeResponseDto> {
    try {
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
  @ApiOperation({
    summary: 'Accept a proposed change (merges text permanently into Docstore)',
  })
  @ApiResponse({ status: 200, type: TrackChangeResponseDto })
  async acceptChange(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Param('changeId') changeId: string,
    @Req() req?: any,
  ): Promise<TrackChangeResponseDto> {
    try {
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
  @ApiOperation({
    summary: 'Reject a proposed change (reverts text in Docstore)',
  })
  @ApiResponse({ status: 200, type: TrackChangeResponseDto })
  async rejectChange(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Param('changeId') changeId: string,
    @Req() req?: any,
  ): Promise<TrackChangeResponseDto> {
    try {
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
  @ApiOperation({
    summary: 'Bulk accept or reject all pending changes in a document',
  })
  @ApiResponse({ status: 200 })
  async batchResolveChanges(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Body() dto: BatchResolveDto,
    @Req() req?: any,
  ) {
    try {
      const userId = req?.user?.id || req?.user?.sub || null;
      return await this.trackChangesService.batchResolveChanges(
        projectId,
        docId,
        dto.action,
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
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Body() dto: CreateCommentThreadDto,
    @Req() req?: any,
  ): Promise<CommentThreadResponseDto> {
    try {
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
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Param('threadId') threadId: string,
    @Body() dto: AddCommentReplyDto,
    @Req() req?: any,
  ): Promise<CommentReplyResponseDto> {
    try {
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

  @Patch(['threads/:threadId/resolve', 'comments/:threadId/resolve'])
  @ApiOperation({ summary: 'Resolve or reopen a comment thread' })
  @ApiResponse({ status: 200, type: CommentThreadResponseDto })
  async resolveCommentThread(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Param('threadId') threadId: string,
    @Body() dto: ResolveThreadDto,
    @Req() req?: any,
  ): Promise<CommentThreadResponseDto> {
    try {
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
