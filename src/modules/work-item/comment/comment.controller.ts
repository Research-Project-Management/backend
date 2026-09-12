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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Planning Tasks & Work Items')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class TaskCommentController {
  constructor(private readonly commentService: TaskCommentService) {}

  @Get('work-items/:taskId/comments')
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get all comments for a work item' })
  async getTaskComments(@Param('taskId') taskId: string) {
    return this.commentService.getTaskComments(taskId);
  }

  @Post('work-items/:taskId/comments')
  @ProjectRoles('owner', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Add a comment to a work item' })
  async createTaskComment(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() createCommentDto: CreateCommentDto,
  ) {
    return this.commentService.createTaskComment(
      taskId,
      userId,
      createCommentDto,
    );
  }

  @Put('work-items/comments/:commentId')
  @ProjectRoles('owner', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Update a WorkItem comment' })
  async updateTaskComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() updateCommentDto: UpdateCommentDto,
  ) {
    return this.commentService.updateTaskComment(
      commentId,
      userId,
      updateCommentDto,
    );
  }

  @Delete('work-items/comments/:commentId')
  @ProjectRoles('owner', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Delete a WorkItem comment' })
  async deleteTaskComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.commentService.deleteTaskComment(commentId, userId);
  }

  @Post('work-items/comments/:commentId/replies')
  @ProjectRoles('owner', 'contributor', 'commenter')
  @ApiOperation({ summary: 'Reply to a WorkItem comment' })
  async addTaskReply(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() addReplyDto: AddReplyDto,
  ) {
    return this.commentService.addTaskReply(commentId, userId, addReplyDto);
  }

  @Post('work-items/comments/:commentId/reactions')
  @ProjectRoles('owner', 'contributor', 'commenter')
  @ApiOperation({ summary: 'React to a WorkItem comment with emoji' })
  async reactToTaskComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() reactCommentDto: ReactCommentDto,
  ) {
    return this.commentService.reactToTaskComment(
      commentId,
      userId,
      reactCommentDto,
    );
  }
}
