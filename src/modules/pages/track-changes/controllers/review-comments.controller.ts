/**
 * modules/pages/track-changes/controllers/review-comments.controller.ts
 * Domain-focused controller handling inline comments, comment threads,
 * replies, and resolution endpoints under `/api/v1/pages`.
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
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedSpace,
  CurrentRole,
} from '@/modules/project/access';
import { AuthenticatedRequest } from '@/core';
import { ReviewCommentsService } from '../services/review-comments.service';

@ApiTags('Manuscripts - Pages Review & Comments')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class ReviewCommentsController {
  constructor(private readonly reviewCommentsService: ReviewCommentsService) {}

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
    return this.reviewCommentsService.getComments(
      pageId,
      status,
      routeProjectId,
      authorizedProjectId,
    );
  }

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
    return this.reviewCommentsService.createComment(
      pageId,
      body,
      req,
      routeProjectId,
      authorizedProjectId,
    );
  }

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
    return this.reviewCommentsService.updateComment(
      pageId,
      commentId,
      body,
      req,
      routeProjectId,
      authorizedProjectId,
      role,
    );
  }

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
    return this.reviewCommentsService.deleteComment(
      pageId,
      commentId,
      req,
      routeProjectId,
      authorizedProjectId,
      role,
    );
  }

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
    return this.reviewCommentsService.addCommentReply(
      pageId,
      commentId,
      body,
      req,
      routeProjectId,
      authorizedProjectId,
    );
  }

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
    return this.reviewCommentsService.updateCommentReply(
      pageId,
      commentId,
      replyId,
      body,
      routeProjectId,
      req,
      authorizedProjectId,
      role,
    );
  }

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
    return this.reviewCommentsService.deleteCommentReply(
      pageId,
      commentId,
      replyId,
      routeProjectId,
      req,
      authorizedProjectId,
      role,
    );
  }

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
    return this.reviewCommentsService.resolveComment(
      pageId,
      commentId,
      body,
      routeProjectId,
      authorizedProjectId,
      currentUserId,
    );
  }
}
