import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CommentRepository } from './comment.repository';
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
import { sanitizeCommentContent } from '../core/utils/document.utils';

@Injectable()
export class CommentService {
  constructor(
    private readonly commentRepo: CommentRepository,
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

    if (comment.page.projectId) {
      const projMember = await this.prisma.projectMember.findUnique({
        where: {
          projectId_userId: { projectId: comment.page.projectId, userId },
        },
      });
      if (projMember?.role === 'owner') {
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

  async getComments(pageId: string) {
    const comments = await this.commentRepo.findComments(pageId);
    return { comments };
  }

  async createComment(pageId: string, userId: string, dto: CreateCommentDto) {
    const cleanContent = sanitizeCommentContent(dto.content);
    if (!cleanContent) {
      throw new UnprocessableEntityException('Comment content cannot be empty');
    }

    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { parentPageId: true },
    });

    const comment = await this.commentRepo.createComment({
      pageId,
      projectPageId: page?.parentPageId || null,
      authorId: userId,
      content: cleanContent,
      status: dto.status || CommentStatus.open,
      line: dto.line,
      lineEnd: dto.lineEnd,
    });

    return { comment };
  }

  async updateComment(
    commentId: string,
    userId: string,
    dto: UpdateCommentDto,
  ) {
    await this.assertCanModifyComment(commentId, userId, 'update');

    let cleanContent: string | undefined;
    if (dto.content !== undefined) {
      cleanContent = sanitizeCommentContent(dto.content);
      if (!cleanContent) {
        throw new UnprocessableEntityException(
          'Comment content cannot be empty',
        );
      }
    }

    const comment = await this.commentRepo.updateComment(commentId, {
      ...(cleanContent !== undefined && { content: cleanContent }),
      ...(dto.status !== undefined && { status: dto.status }),
      isEdited: true,
    });

    return { comment };
  }

  async deleteComment(commentId: string, userId: string) {
    await this.assertCanModifyComment(commentId, userId, 'delete');

    await this.commentRepo.deleteComment(commentId);
    return { success: true };
  }

  async addReply(commentId: string, userId: string, dto: AddReplyDto) {
    const existing = await this.commentRepo.findCommentById(commentId);
    if (!existing) {
      throw new NotFoundException('Comment not found');
    }

    const commentPage = (existing as any).page;
    if (commentPage?.projectId) {
      const member = await this.prisma.projectMember.findUnique({
        where: {
          projectId_userId: { projectId: commentPage.projectId, userId },
        },
      });
      if (!member) {
        throw new ForbiddenException(
          'You do not have permission to reply to comments in this project',
        );
      }
    }

    const cleanContent = sanitizeCommentContent(dto.content);
    if (!cleanContent) {
      throw new UnprocessableEntityException('Reply content cannot be empty');
    }

    const author = await this.commentRepo.findAuthorById(userId);
    const replies = parseCommentReplies(existing.replies);
    const newReply = this.buildReply(cleanContent, author);
    replies.push(newReply);

    const comment = await this.commentRepo.updateComment(commentId, {
      replies: replies as unknown as Prisma.InputJsonValue,
    });

    return { comment };
  }

  async deleteReply(commentId: string, replyId: string, userId: string) {
    const existing = await this.prisma.pageComment.findUnique({
      where: { id: commentId },
      include: {
        page: {
          select: {
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
      let isProjOwner = false;
      if (existing.page.projectId) {
        const projMember = await this.prisma.projectMember.findUnique({
          where: {
            projectId_userId: { projectId: existing.page.projectId, userId },
          },
        });
        isProjOwner = projMember?.role === 'owner';
      }

      if (!isProjOwner) {
        throw new ForbiddenException(
          'You do not have permission to delete this reply',
        );
      }
    }

    const filteredReplies = replies.filter((r) => r.id !== replyId);
    const comment = await this.commentRepo.updateComment(commentId, {
      replies: filteredReplies as unknown as Prisma.InputJsonValue,
    });

    return { comment };
  }

  // Backward-compatible aliases
  getPageComments = this.getComments.bind(this);
  createPageComment = this.createComment.bind(this);
  updatePageComment = this.updateComment.bind(this);
  deletePageComment = this.deleteComment.bind(this);
  addPageReply = this.addReply.bind(this);
  deletePageReply = this.deleteReply.bind(this);
}

export const PageCommentService = CommentService;
export type PageCommentService = CommentService;
