import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { TaskCommentRepository } from './comment.repository';
import {
  CreateCommentDto,
  UpdateCommentDto,
  AddReplyDto,
  ReactCommentDto,
} from './dto/comment.dto';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  parseCommentReplies,
  CommentReply,
  CommentAuthor,
} from './types/comment.types';
import { PrismaService } from '@/core/database/prisma.service';

@Injectable()
export class TaskCommentService {
  constructor(
    private readonly commentRepo: TaskCommentRepository,
    private readonly prisma: PrismaService,
  ) {}

  private async assertCanModifyComment(
    commentId: string,
    userId: string,
    action: string,
  ) {
    const comment = await this.prisma.taskComment.findUnique({
      where: { id: commentId },
      include: {
        task: {
          select: {
            projectId: true,
            project: { select: { workspaceId: true } },
          },
        },
      },
    });

    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    if (comment.authorId === userId) {
      return comment;
    }

    const wsMember = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId: comment.task.project.workspaceId, userId },
    });
    if (wsMember?.role === 'owner' || wsMember?.role === 'admin') {
      return comment;
    }

    const projMember = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId: comment.task.projectId, userId },
      },
    });
    if (projMember?.role === 'admin') {
      return comment;
    }

    throw new ForbiddenException(
      `You do not have permission to ${action} this comment`,
    );
  }

  private buildReply(
    content: string,
    user: CommentAuthor | null,
  ): CommentReply {
    const id = randomUUID();
    return {
      id,
      content,
      author: user,
      createdAt: new Date().toISOString(),
    };
  }

  async getTaskComments(taskId: string) {
    const comments = await this.commentRepo.findTaskComments(taskId);
    return { comments };
  }

  async createTaskComment(
    taskId: string,
    userId: string,
    dto: CreateCommentDto,
  ) {
    const comment = await this.commentRepo.createTaskComment({
      taskId,
      authorId: userId,
      content: dto.content,
    });

    return { comment };
  }

  async updateTaskComment(
    commentId: string,
    userId: string,
    dto: UpdateCommentDto,
  ) {
    await this.assertCanModifyComment(commentId, userId, 'update');

    const comment = await this.commentRepo.updateTaskComment(commentId, {
      content: dto.content,
      isEdited: true,
    });

    return { comment };
  }

  async deleteTaskComment(commentId: string, userId: string) {
    await this.assertCanModifyComment(commentId, userId, 'delete');

    await this.commentRepo.deleteTaskComment(commentId);
    return { success: true };
  }

  async addTaskReply(commentId: string, userId: string, dto: AddReplyDto) {
    const existing = await this.commentRepo.findTaskCommentById(commentId);
    if (!existing) {
      throw new NotFoundException('Comment not found');
    }

    const author = await this.commentRepo.findAuthorById(userId);
    const replies = parseCommentReplies(existing.replies);
    const newReply = this.buildReply(dto.content, author);
    replies.push(newReply);

    const comment = await this.commentRepo.updateTaskComment(commentId, {
      replies: replies as unknown as Prisma.InputJsonValue,
    });

    return { comment };
  }

  async reactToTaskComment(
    commentId: string,
    userId: string,
    dto: ReactCommentDto,
  ) {
    const existing = await this.commentRepo.findTaskCommentById(commentId);
    if (!existing) {
      throw new NotFoundException('Comment not found');
    }

    const reactions = (existing.reactions as Record<string, string[]>) || {};
    const users = reactions[dto.emoji] || [];
    const index = users.indexOf(userId);

    if (index > -1) {
      users.splice(index, 1);
    } else {
      users.push(userId);
    }

    reactions[dto.emoji] = users;

    const comment = await this.commentRepo.updateTaskComment(commentId, {
      reactions: reactions,
    });

    return { comment };
  }
}
