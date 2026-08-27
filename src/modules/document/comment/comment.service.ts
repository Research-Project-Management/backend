import { Injectable, NotFoundException } from '@nestjs/common';
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

@Injectable()
export class PageCommentService {
  constructor(private readonly commentRepo: PageCommentRepository) {}

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

  async updatePageComment(commentId: string, dto: UpdateCommentDto) {
    const comment = await this.commentRepo.updatePageComment(commentId, {
      content: dto.content,
      status: dto.status,
      isEdited: true,
    });

    return { comment };
  }

  async deletePageComment(commentId: string) {
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

  async deletePageReply(commentId: string, replyId: string) {
    const existing = await this.commentRepo.findPageCommentById(commentId);
    if (!existing) {
      throw new NotFoundException('Comment not found');
    }

    const replies = parseCommentReplies(existing.replies).filter(
      (r) => r.id !== replyId,
    );
    const comment = await this.commentRepo.updatePageComment(commentId, {
      replies: replies as unknown as Prisma.InputJsonValue,
    });

    return { comment };
  }
}
