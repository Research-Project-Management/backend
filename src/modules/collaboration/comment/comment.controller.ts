import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { CommentService } from './comment.service';
import {
  CreatePageCommentDto,
  UpdatePageCommentDto,
  AddReplyDto,
  CreateTaskCommentDto,
  UpdateTaskCommentDto,
  ReactTaskCommentDto,
} from './dto/comment.dto';
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

@ApiTags('Collaboration')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  // ── Page Comments ──────────────────────────────────────────────────────────

  @Get('pages/:pageId/comments')
  async getPageComments(@Param('pageId') pageId: string) {
    return this.commentService.getPageComments(pageId);
  }

  @Post('pages/:pageId/comments')
  @HttpCode(HttpStatus.CREATED)
  async createPageComment(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePageCommentDto,
  ) {
    return this.commentService.createPageComment(pageId, userId, dto);
  }

  @Put('pages/:pageId/comments/:commentId')
  async updatePageComment(
    @Param('commentId') commentId: string,
    @Body() dto: UpdatePageCommentDto,
  ) {
    return this.commentService.updatePageComment(commentId, dto);
  }

  @Delete('pages/:pageId/comments/:commentId')
  async deletePageComment(@Param('commentId') commentId: string) {
    return this.commentService.deletePageComment(commentId);
  }

  @Post('pages/:pageId/comments/:commentId/replies')
  @HttpCode(HttpStatus.CREATED)
  async addPageReply(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AddReplyDto,
  ) {
    return this.commentService.addPageReply(commentId, userId, dto);
  }

  @Delete('pages/:pageId/comments/:commentId/replies/:replyId')
  async deletePageReply(
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
  ) {
    return this.commentService.deletePageReply(commentId, replyId);
  }

  // ── Task Comments ──────────────────────────────────────────────────────────

  @Get('tasks/:taskId/comments/count')
  async getTaskCommentsCount(@Param('taskId') taskId: string) {
    return this.commentService.getTaskCommentsCount(taskId);
  }

  @Get('tasks/:taskId/comments')
  async getTaskComments(@Param('taskId') taskId: string) {
    return this.commentService.getTaskComments(taskId);
  }

  @Post('tasks/:taskId/comments')
  @HttpCode(HttpStatus.CREATED)
  async createTaskComment(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTaskCommentDto,
  ) {
    return this.commentService.createTaskComment(taskId, userId, dto);
  }

  @Put('tasks/:taskId/comments/:commentId')
  async updateTaskComment(
    @Param('commentId') commentId: string,
    @Body() dto: UpdateTaskCommentDto,
  ) {
    return this.commentService.updateTaskComment(commentId, dto);
  }

  @Delete('tasks/:taskId/comments/:commentId')
  async deleteTaskComment(@Param('commentId') commentId: string) {
    return this.commentService.deleteTaskComment(commentId);
  }

  @Put('tasks/:taskId/comments/:commentId/reaction')
  async reactTaskComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ReactTaskCommentDto,
  ) {
    return this.commentService.reactTaskComment(commentId, userId, dto.emoji);
  }

  @Post('tasks/:taskId/comments/:commentId/replies')
  @HttpCode(HttpStatus.CREATED)
  async addTaskReply(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AddReplyDto,
  ) {
    return this.commentService.addTaskReply(commentId, userId, dto);
  }

  @Delete('tasks/:taskId/comments/:commentId/replies/:replyId')
  async deleteTaskReply(
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
  ) {
    return this.commentService.deleteTaskReply(commentId, replyId);
  }
}
