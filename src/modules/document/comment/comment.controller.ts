import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CommentService } from './comment.service';
import {
  CreateCommentDto,
  UpdateCommentDto,
  AddReplyDto,
} from './dto/comment.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Document - Comments')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @Get([
    'comments',
    'pages/:pageId/comments',
    'page/:pageId/comments',
    'documents/:pageId/comments',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get all comments for a document page' })
  async getComments(
    @Param('pageId') pageId?: string,
    @Query('pageId') queryPageId?: string,
  ) {
    const effectivePageId = pageId || queryPageId || '';
    return this.commentService.getComments(effectivePageId);
  }

  @Post([
    'comments',
    'pages/:pageId/comments',
    'page/:pageId/comments',
    'documents/:pageId/comments',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Add a comment to a manuscript page' })
  async createComment(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCommentDto,
    @Param('pageId') pageId?: string,
  ) {
    const effectivePageId = pageId || dto.pageId || '';
    return this.commentService.createComment(effectivePageId, userId, dto);
  }

  @Put([
    'comments/:commentId',
    'pages/:pageId/comments/:commentId',
    'pages/comments/:commentId',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Update a page comment' })
  async updateComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.commentService.updateComment(commentId, userId, dto);
  }

  @Delete([
    'comments/:commentId',
    'pages/:pageId/comments/:commentId',
    'pages/comments/:commentId',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Delete a page comment' })
  async deleteComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.commentService.deleteComment(commentId, userId);
  }

  @Post([
    'comments/:commentId/replies',
    'pages/:pageId/comments/:commentId/replies',
    'pages/comments/:commentId/replies',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Reply to a page comment' })
  async addReply(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AddReplyDto,
  ) {
    return this.commentService.addReply(commentId, userId, dto);
  }

  @Delete([
    'comments/:commentId/replies/:replyId',
    'pages/:pageId/comments/:commentId/replies/:replyId',
    'pages/comments/:commentId/replies/:replyId',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Delete a reply from a page comment' })
  async deleteReply(
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.commentService.deleteReply(commentId, replyId, userId);
  }

  // Backward-compatible aliases
  getPageComments = this.getComments.bind(this);
  createPageComment = this.createComment.bind(this);
  updatePageComment = this.updateComment.bind(this);
  deletePageComment = this.deleteComment.bind(this);
  addPageReply = this.addReply.bind(this);
  deletePageReply = this.deleteReply.bind(this);
}

export const PageCommentController = CommentController;
export type PageCommentController = CommentController;
