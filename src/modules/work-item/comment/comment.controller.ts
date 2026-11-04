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
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Work Items')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @Get('work-items/:workItemId/comments')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get all comments for a work item' })
  async getComments(@Param('workItemId') workItemId: string) {
    return this.commentService.getComments(workItemId);
  }

  @Post('work-items/:workItemId/comments')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Add a comment to a work item' })
  async createComment(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() createCommentDto: CreateCommentDto,
  ) {
    return this.commentService.createComment(
      workItemId,
      userId,
      createCommentDto,
    );
  }

  @Put('work-items/comments/:commentId')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Update a WorkItem comment' })
  async updateComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() updateCommentDto: UpdateCommentDto,
  ) {
    return this.commentService.updateComment(
      commentId,
      userId,
      updateCommentDto,
    );
  }

  @Delete('work-items/comments/:commentId')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Delete a WorkItem comment' })
  async deleteComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.commentService.deleteComment(commentId, userId);
  }

  @Post('work-items/comments/:commentId/replies')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Reply to a WorkItem comment' })
  async addReply(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() addReplyDto: AddReplyDto,
  ) {
    return this.commentService.addReply(commentId, userId, addReplyDto);
  }

  @Post('work-items/comments/:commentId/reactions')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'React to a WorkItem comment with emoji' })
  async reactToComment(
    @Param('commentId') commentId: string,
    @CurrentUser('id') userId: string,
    @Body() reactCommentDto: ReactCommentDto,
  ) {
    return this.commentService.reactToComment(
      commentId,
      userId,
      reactCommentDto,
    );
  }
}
