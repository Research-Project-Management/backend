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
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';

@ApiTags('Planning Tasks & Work Items')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class TaskCommentController {
  constructor(private readonly commentService: TaskCommentService) {}

  @Get(['tasks/:taskId/comments', 'work-items/:taskId/comments'])
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get all comments for a task' })
  async getTaskComments(@Param('taskId') taskId: string) {
    return this.commentService.getTaskComments(taskId);
  }

  @Post(['tasks/:taskId/comments', 'work-items/:taskId/comments'])
  @ProjectRoles('admin', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Add a comment to a task' })
  async createTaskComment(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.commentService.createTaskComment(taskId, userId, dto);
  }

  @Put(['tasks/comments/:commentId', 'work-items/comments/:commentId'])
  @ProjectRoles('admin', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Update a task comment' })
  async updateTaskComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.commentService.updateTaskComment(commentId, userId, dto);
  }

  @Delete(['tasks/comments/:commentId', 'work-items/comments/:commentId'])
  @ProjectRoles('admin', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Delete a task comment' })
  async deleteTaskComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.commentService.deleteTaskComment(commentId, userId);
  }

  @Post([
    'tasks/comments/:commentId/replies',
    'work-items/comments/:commentId/replies',
  ])
  @ProjectRoles('admin', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Reply to a task comment' })
  async addTaskReply(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AddReplyDto,
  ) {
    return this.commentService.addTaskReply(commentId, userId, dto);
  }

  @Post([
    'tasks/comments/:commentId/reactions',
    'work-items/comments/:commentId/reactions',
  ])
  @ProjectRoles('admin', 'contributor', 'commenter')
  @ApiOperation({ summary: 'React to a task comment with emoji' })
  async reactToTaskComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ReactCommentDto,
  ) {
    return this.commentService.reactToTaskComment(commentId, userId, dto);
  }
}
