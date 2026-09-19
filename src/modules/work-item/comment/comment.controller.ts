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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Work Items')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @Get('work-items/:workItemId/comments')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get all comments for a work item' })
  async getWorkItemComments(@Param('workItemId') workItemId: string) {
    return this.commentService.getWorkItemComments(workItemId);
  }

  @Post('work-items/:workItemId/comments')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Add a comment to a work item' })
  async createWorkItemComment(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() createCommentDto: CreateCommentDto,
  ) {
    return this.commentService.createWorkItemComment(
      workItemId,
      userId,
      createCommentDto,
    );
  }

  @Put('work-items/comments/:commentId')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Update a WorkItem comment' })
  async updateWorkItemComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() updateCommentDto: UpdateCommentDto,
  ) {
    return this.commentService.updateWorkItemComment(
      commentId,
      userId,
      updateCommentDto,
    );
  }

  @Delete('work-items/comments/:commentId')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Delete a WorkItem comment' })
  async deleteWorkItemComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.commentService.deleteWorkItemComment(commentId, userId);
  }

  @Post('work-items/comments/:commentId/replies')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Reply to a WorkItem comment' })
  async addWorkItemReply(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() addReplyDto: AddReplyDto,
  ) {
    return this.commentService.addWorkItemReply(commentId, userId, addReplyDto);
  }

  @Post('work-items/comments/:commentId/reactions')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'React to a WorkItem comment with emoji' })
  async reactToWorkItemComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() reactCommentDto: ReactCommentDto,
  ) {
    return this.commentService.reactToWorkItemComment(
      commentId,
      userId,
      reactCommentDto,
    );
  }
}
