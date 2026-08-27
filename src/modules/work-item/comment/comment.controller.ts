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
import { TaskCommentService } from './comment.service';
import {
  CreateCommentDto,
  UpdateCommentDto,
  AddReplyDto,
  ReactCommentDto,
} from './dto/comment.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';

@ApiTags('Planning Tasks & Work Items')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class TaskCommentController {
  constructor(private readonly commentService: TaskCommentService) {}

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
}
