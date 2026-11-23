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
@Controller('api/v1/pages/docs/:docId/comments')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Get()
  async list(
    @Param('docId') docId: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    const parsedLimit =
      limit !== undefined && limit !== ''
        ? Number.parseInt(limit, 10)
        : undefined;
    const pagination =
      cursor || (parsedLimit !== undefined && Number.isFinite(parsedLimit))
        ? {
            cursor: cursor || undefined,
            limit:
              parsedLimit !== undefined && Number.isFinite(parsedLimit)
                ? parsedLimit
                : undefined,
          }
        : undefined;

    return this.commentsService.list(
      docId,
      status,
      undefined,
      authSpace,
      pagination,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('docId') docId: string,
    @Body() body: CreateCommentDto,
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    return this.commentsService.create(docId, body, req, undefined, authSpace);
  }

  @Patch(':commentId')
  async update(
    @Param('docId') docId: string,
    @Param('commentId') commentId: string,
    @Body() body: UpdateCommentDto,
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    return this.commentsService.update(
      docId,
      commentId,
      body,
      req,
      undefined,
      authSpace,
      role,
    );
  }

  @Delete(':commentId')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('docId') docId: string,
    @Param('commentId') commentId: string,
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    return this.commentsService.remove(
      docId,
      commentId,
      req,
      undefined,
      authSpace,
      role,
    );
  }

  @Post(':commentId/replies')
  @HttpCode(HttpStatus.CREATED)
  async addReply(
    @Param('docId') docId: string,
    @Param('commentId') commentId: string,
    @Body() body: ReplyDto,
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    return this.commentsService.addReply(
      docId,
      commentId,
      body,
      req,
      undefined,
      authSpace,
    );
  }

  @Patch(':commentId/replies/:replyId')
  @HttpCode(HttpStatus.OK)
  async updateReply(
    @Param('docId') docId: string,
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
    @Body() body: ReplyDto,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    return this.commentsService.updateReply(
      docId,
      commentId,
      replyId,
      body,
      undefined,
      req,
      authSpace,
      role,
    );
  }

  @Delete(':commentId/replies/:replyId')
  @HttpCode(HttpStatus.OK)
  async deleteReply(
    @Param('docId') docId: string,
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentRole() role?: Role,
  ) {
    return this.commentsService.deleteReply(
      docId,
      commentId,
      replyId,
      undefined,
      req,
      authSpace,
      role,
    );
  }

  @Patch(':commentId/resolve')
  @RequireRole(Role.CONTRIBUTOR)
  async resolve(
    @Param('docId') docId: string,
    @Param('commentId') commentId: string,
    @Body() body: ResolveCommentDto,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentUser('id') currentUserId?: string,
  ) {
    return this.commentsService.resolve(
      docId,
      commentId,
      body,
      undefined,
      authSpace,
      currentUserId,
    );
  }
}
