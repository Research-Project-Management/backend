import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedRequest } from '@/core';
import { CurrentUser, JwtAuthGuard } from '@/modules/identity/auth';
import {
  CurrentRole,
  ProjectAccessGuard,
  RequireRole,
  ResolvedSpace,
  Role,
} from '@/modules/project/access';
import {
  CreateCommentDto,
  ReplyDto,
  ResolveCommentDto,
  UpdateCommentDto,
} from '../dto/review.dto';
import { CommentsService } from '../services/comments.service';

@ApiTags('Manuscripts - Pages Review & Comments')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Get([
    'pages/:pageId/comments',
    'docs/:docId/comments',
    'spaces/:spaceId/docs/:docId/comments',
  ])
  async list(
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Query('status') status?: string,
    @Param('spaceId') spaceId?: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    return this.commentsService.list(
      docId || pageId || '',
      status,
      spaceId,
      authSpace,
    );
  }

  @Post([
    'pages/:pageId/comments',
    'docs/:docId/comments',
    'spaces/:spaceId/docs/:docId/comments',
  ])
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: CreateCommentDto,
    @Req() req: AuthenticatedRequest,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    return this.commentsService.create(
      docId || pageId || '',
      body,
      req,
      spaceId,
      authSpace,
    );
  }

  @Patch([
    'pages/:pageId/comments/:commentId',
    'docs/:docId/comments/:commentId',
    'spaces/:spaceId/docs/:docId/comments/:commentId',
  ])
  async update(
    @Param('commentId') commentId: string,
    @Body() body: UpdateCommentDto,
    @Req() req: AuthenticatedRequest,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    return this.commentsService.update(
      docId || pageId || '',
      commentId,
      body,
      req,
      spaceId,
      authSpace,
      role,
    );
  }

  @Delete([
    'pages/:pageId/comments/:commentId',
    'docs/:docId/comments/:commentId',
    'spaces/:spaceId/docs/:docId/comments/:commentId',
  ])
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('commentId') commentId: string,
    @Req() req: AuthenticatedRequest,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    return this.commentsService.remove(
      docId || pageId || '',
      commentId,
      req,
      spaceId,
      authSpace,
      role,
    );
  }

  @Post([
    'pages/:pageId/comments/:commentId/reply',
    'pages/:pageId/comments/:commentId/replies',
    'docs/:docId/comments/:commentId/reply',
    'docs/:docId/comments/:commentId/replies',
    'spaces/:spaceId/docs/:docId/comments/:commentId/reply',
    'spaces/:spaceId/docs/:docId/comments/:commentId/replies',
  ])
  @HttpCode(HttpStatus.CREATED)
  async addReply(
    @Param('commentId') commentId: string,
    @Body() body: ReplyDto,
    @Req() req: AuthenticatedRequest,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    return this.commentsService.addReply(
      docId || pageId || '',
      commentId,
      body,
      req,
      spaceId,
      authSpace,
    );
  }

  @Patch([
    'pages/:pageId/comments/:commentId/replies/:replyId',
    'docs/:docId/comments/:commentId/replies/:replyId',
    'spaces/:spaceId/docs/:docId/comments/:commentId/replies/:replyId',
  ])
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  async updateReply(
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
    @Body() body: ReplyDto,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    return this.commentsService.updateReply(
      docId || pageId || '',
      commentId,
      replyId,
      body,
      spaceId,
      req,
      authSpace,
      role,
    );
  }

  @Delete([
    'pages/:pageId/comments/:commentId/replies/:replyId',
    'docs/:docId/comments/:commentId/replies/:replyId',
    'spaces/:spaceId/docs/:docId/comments/:commentId/replies/:replyId',
  ])
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  async deleteReply(
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    return this.commentsService.deleteReply(
      docId || pageId || '',
      commentId,
      replyId,
      spaceId,
      req,
      authSpace,
      role,
    );
  }

  @Patch([
    'pages/:pageId/comments/:commentId/resolve',
    'docs/:docId/comments/:commentId/resolve',
    'spaces/:spaceId/docs/:docId/comments/:commentId/resolve',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  async resolve(
    @Param('commentId') commentId: string,
    @Body() body: ResolveCommentDto,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentUser('id') currentUserId?: string,
  ) {
    return this.commentsService.resolve(
      docId || pageId || '',
      commentId,
      body,
      spaceId,
      authSpace,
      currentUserId,
    );
  }
}
