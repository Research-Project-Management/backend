import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PageCommentRepository } from './comment.repository';
import {
  CreateCommentDto,
  UpdateCommentDto,
  AddReplyDto,
} from './dto/comment.dto';
import { CommentStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  parseCommentReplies,
  CommentReply,
  CommentAuthor,
} from './types/comment.types';
import { PrismaService } from '@/core/database/prisma.service';

@Injectable()
export class PageCommentService {
  constructor(
    private readonly commentRepo: PageCommentRepository,
    private readonly prisma: PrismaService,
  ) {}

  private async assertCanModifyComment(
    commentId: string,
    userId: string,
    action: string,
  ) {
    const comment = await this.prisma.pageComment.findUnique({
      where: { id: commentId },
      include: {
        page: {
          select: {
            workspaceId: true,
            projectId: true,
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
      where: { workspaceId: comment.page.workspaceId, userId },
    });
    if (wsMember?.role === 'owner' || wsMember?.role === 'admin') {
      return comment;
    }

    if (comment.page.projectId) {
      const projMember = await this.prisma.projectMember.findUnique({
        where: {
          projectId_userId: { projectId: comment.page.projectId, userId },
        },
      });
      if (projMember?.role === 'admin') {
        return comment;
      }
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

  async getPageComments(pageId: string) {
    const comments = await this.commentRepo.findPageComments(pageId);
    return { comments };
  }

  async createPageComment(
    pageId: string,
    userId: string,
    dto: CreateCommentDto,
  ) {
    const comment = await this.commentRepo.createPageComment({
      pageId,
      authorId: userId,
      content: dto.content,
      status: dto.status || CommentStatus.open,
      line: dto.line,
      lineEnd: dto.lineEnd,
    });

    return { comment };
  }

  async updatePageComment(
    commentId: string,
    userId: string,
    dto: UpdateCommentDto,
  ) {
    await this.assertCanModifyComment(commentId, userId, 'update');

    const comment = await this.commentRepo.updatePageComment(commentId, {
      content: dto.content,
      status: dto.status,
      isEdited: true,
    });

    return { comment };
  }

  async deletePageComment(commentId: string, userId: string) {
    await this.assertCanModifyComment(commentId, userId, 'delete');

    await this.commentRepo.deletePageComment(commentId);
    return { success: true };
  }

  async addPageReply(commentId: string, userId: string, dto: AddReplyDto) {
    const existing = await this.commentRepo.findPageCommentById(commentId);
    if (!existing) {
      throw new NotFoundException('Comment not found');
    }

    const author = await this.commentRepo.findAuthorById(userId);
    const replies = parseCommentReplies(existing.replies);
    const newReply = this.buildReply(dto.content, author);
    replies.push(newReply);

    const comment = await this.commentRepo.updatePageComment(commentId, {
      replies: replies as unknown as Prisma.InputJsonValue,
    });

    return { comment };
  }

  async deletePageReply(commentId: string, replyId: string, userId: string) {
    const existing = await this.prisma.pageComment.findUnique({
      where: { id: commentId },
      include: {
        page: {
          select: {
            workspaceId: true,
            projectId: true,
          },
        },
      },
    });
    if (!existing) {
      throw new NotFoundException('Comment not found');
    }

    const replies = parseCommentReplies(existing.replies);
    const targetReply = replies.find((r) => r.id === replyId);

    if (targetReply?.author?.id !== userId) {
      const wsMember = await this.prisma.workspaceMember.findFirst({
        where: { workspaceId: existing.page.workspaceId, userId },
      });
      const isWsAdmin =
        wsMember?.role === 'owner' || wsMember?.role === 'admin';

      let isProjAdmin = false;
      if (existing.page.projectId) {
        const projMember = await this.prisma.projectMember.findUnique({
          where: {
            projectId_userId: { projectId: existing.page.projectId, userId },
          },
        });
        isProjAdmin = projMember?.role === 'admin';
      }

      if (!isWsAdmin && !isProjAdmin) {
        throw new ForbiddenException(
          'You do not have permission to delete this reply',
        );
      }
    }

    const filteredReplies = replies.filter((r) => r.id !== replyId);
    const comment = await this.commentRepo.updatePageComment(commentId, {
      replies: filteredReplies as unknown as Prisma.InputJsonValue,
    });

    return { comment };
  }
}
