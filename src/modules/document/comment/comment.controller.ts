import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PageCommentService } from './comment.service';
import {
  CreateCommentDto,
  UpdateCommentDto,
  AddReplyDto,
} from './dto/comment.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';

@ApiTags('Document - Comments')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class PageCommentController {
  constructor(private readonly commentService: PageCommentService) {}

  @Get(['pages/:pageId/comments', 'page/:pageId/comments'])
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get all comments for a manuscript page' })
  async getPageComments(@Param('pageId') pageId: string) {
    return this.commentService.getPageComments(pageId);
  }

  @Post(['pages/:pageId/comments', 'page/:pageId/comments'])
  @ProjectRoles('admin', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Add a comment to a manuscript page' })
  async createPageComment(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.commentService.createPageComment(pageId, userId, dto);
  }

  @Put(['pages/:pageId/comments/:commentId', 'pages/comments/:commentId'])
  @ProjectRoles('admin', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Update a page comment' })
  async updatePageComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.commentService.updatePageComment(commentId, userId, dto);
  }

  @Delete(['pages/:pageId/comments/:commentId', 'pages/comments/:commentId'])
  @ProjectRoles('admin', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Delete a page comment' })
  async deletePageComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.commentService.deletePageComment(commentId, userId);
  }

  @Post([
    'pages/:pageId/comments/:commentId/replies',
    'pages/comments/:commentId/replies',
  ])
  @ProjectRoles('admin', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Reply to a page comment' })
  async addPageReply(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AddReplyDto,
  ) {
    return this.commentService.addPageReply(commentId, userId, dto);
  }

  @Delete([
    'pages/:pageId/comments/:commentId/replies/:replyId',
    'pages/comments/:commentId/replies/:replyId',
  ])
  @ProjectRoles('admin', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Delete a reply from a page comment' })
  async deletePageReply(
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.commentService.deletePageReply(commentId, replyId, userId);
  }
}
