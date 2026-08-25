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
import { CommentService } from './comment.service';
import {
  CreateCommentDto,
  UpdateCommentDto,
  AddReplyDto,
  ReactCommentDto,
} from './dto/comment.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';

@ApiTags('Shared - Comments')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  // ─── Task Comments ───
  @Get('tasks/:taskId/comments')
  @ApiOperation({ summary: 'Get all comments for a task' })
  async getTaskComments(@Param('taskId') taskId: string) {
    return this.commentService.getTaskComments(taskId);
  }

  @Post('tasks/:taskId/comments')
  @ApiOperation({ summary: 'Add a comment to a task' })
  async createTaskComment(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.commentService.createTaskComment(taskId, userId, dto);
  }

  @Put('tasks/comments/:commentId')
  @ApiOperation({ summary: 'Update a task comment' })
  async updateTaskComment(
    @Param('commentId') commentId: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.commentService.updateTaskComment(commentId, dto);
  }

  @Delete('tasks/comments/:commentId')
  @ApiOperation({ summary: 'Delete a task comment' })
  async deleteTaskComment(@Param('commentId') commentId: string) {
    return this.commentService.deleteTaskComment(commentId);
  }

  @Post('tasks/comments/:commentId/replies')
  @ApiOperation({ summary: 'Reply to a task comment' })
  async addTaskReply(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AddReplyDto,
  ) {
    return this.commentService.addTaskReply(commentId, userId, dto);
  }

  @Post('tasks/comments/:commentId/reactions')
  @ApiOperation({ summary: 'React to a task comment with emoji' })
  async reactToTaskComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ReactCommentDto,
  ) {
    return this.commentService.reactToTaskComment(commentId, userId, dto);
  }

  // ─── Page Comments ───
  @Get('pages/:pageId/comments')
  @ApiOperation({ summary: 'Get all comments for a manuscript page' })
  async getPageComments(@Param('pageId') pageId: string) {
    return this.commentService.getPageComments(pageId);
  }

  @Post('pages/:pageId/comments')
  @ApiOperation({ summary: 'Add a comment to a manuscript page' })
  async createPageComment(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.commentService.createPageComment(pageId, userId, dto);
  }

  @Put(['pages/:pageId/comments/:commentId', 'pages/comments/:commentId'])
  @ApiOperation({ summary: 'Update a page comment' })
  async updatePageComment(
    @Param('commentId') commentId: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.commentService.updatePageComment(commentId, dto);
  }

  @Delete(['pages/:pageId/comments/:commentId', 'pages/comments/:commentId'])
  @ApiOperation({ summary: 'Delete a page comment' })
  async deletePageComment(@Param('commentId') commentId: string) {
    return this.commentService.deletePageComment(commentId);
  }

  @Post([
    'pages/:pageId/comments/:commentId/replies',
    'pages/comments/:commentId/replies',
  ])
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
  @ApiOperation({ summary: 'Delete a reply from a page comment' })
  async deletePageReply(
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
  ) {
    return this.commentService.deletePageReply(commentId, replyId);
  }
}
