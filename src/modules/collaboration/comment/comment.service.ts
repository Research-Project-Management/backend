import { Injectable, NotFoundException } from '@nestjs/common';
import { CommentRepository } from './comment.repository';
import {
  CreatePageCommentDto,
  UpdatePageCommentDto,
  AddReplyDto,
  CreateTaskCommentDto,
  UpdateTaskCommentDto,
} from './dto/comment.dto';
import { CommentStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  parseCommentReplies,
  CommentReply,
  CommentAuthor,
} from '@/core/types/json-fields.type';

@Injectable()
export class CommentService {
  constructor(private readonly commentRepo: CommentRepository) {}

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

  // ── Page Comments ──────────────────────────────────────────────────────────

  async getPageComments(pageId: string) {
    const comments = await this.commentRepo.findPageComments(pageId);
    return { comments };
  }

  async createPageComment(
    pageId: string,
    userId: string,
    dto: CreatePageCommentDto,
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

  async updatePageComment(commentId: string, dto: UpdatePageCommentDto) {
    const comment = await this.commentRepo.updatePageComment(commentId, {
      ...(dto.content !== undefined && {
        content: dto.content,
        isEdited: true,
      }),
      ...(dto.status !== undefined && { status: dto.status }),
    });

    return { comment };
  }

  async deletePageComment(commentId: string) {
    await this.commentRepo.deletePageComment(commentId);
    return { message: 'Comment deleted successfully' };
  }

  async addPageReply(commentId: string, userId: string, dto: AddReplyDto) {
    const [user, comment] = await Promise.all([
      this.commentRepo.findAuthorById(userId),
      this.commentRepo.findPageCommentById(commentId),
    ]);

    if (!comment) throw new NotFoundException('Comment not found');

    const reply = this.buildReply(dto.content, user);
    const currentReplies = parseCommentReplies(comment.replies);
    const updatedReplies = [...currentReplies, reply];

    const updated = await this.commentRepo.updatePageComment(commentId, {
      replies: updatedReplies as unknown as Prisma.InputJsonValue,
    });

    return { comment: updated, reply };
  }

  async deletePageReply(commentId: string, replyId: string) {
    const comment = await this.commentRepo.findPageCommentById(commentId);
    if (!comment) throw new NotFoundException('Comment not found');

    const currentReplies = parseCommentReplies(comment.replies);
    const updatedReplies = currentReplies.filter((r) => r.id !== replyId);

    const updated = await this.commentRepo.updatePageComment(commentId, {
      replies: updatedReplies as unknown as Prisma.InputJsonValue,
    });

    return { comment: updated };
  }

  // ── Task Comments ──────────────────────────────────────────────────────────

  async getTaskComments(taskId: string) {
    const comments = await this.commentRepo.findTaskComments(taskId);
    return { comments };
  }

  async getTaskCommentsCount(taskId: string) {
    const count = await this.commentRepo.countTaskComments(taskId);
    return { count };
  }

  async createTaskComment(
    taskId: string,
    userId: string,
    dto: CreateTaskCommentDto,
  ) {
    const comment = await this.commentRepo.createTaskComment({
      taskId,
      authorId: userId,
      content: dto.content,
    });

    return { comment };
  }

  async updateTaskComment(commentId: string, dto: UpdateTaskCommentDto) {
    const comment = await this.commentRepo.updateTaskComment(commentId, {
      ...(dto.content !== undefined && {
        content: dto.content,
        isEdited: true,
      }),
    });

    return { comment };
  }

  async deleteTaskComment(commentId: string) {
    await this.commentRepo.deleteTaskComment(commentId);
    return { message: 'Comment deleted successfully' };
  }

  async reactTaskComment(commentId: string, userId: string, emoji: string) {
    const comment = await this.commentRepo.findTaskCommentById(commentId);
    if (!comment) throw new NotFoundException('Comment not found');

    interface TaskReactionItem {
      emoji: string;
      count: number;
      users: string[];
    }

    const rawReactions = Array.isArray(comment.reactions)
      ? (comment.reactions as unknown as TaskReactionItem[])
      : [];
    const reactions = [...rawReactions];
    const existingIndex = reactions.findIndex((r) => r.emoji === emoji);

    if (existingIndex > -1) {
      const userIndex = reactions[existingIndex].users?.indexOf(userId) ?? -1;
      if (userIndex > -1) {
        reactions[existingIndex].users.splice(userIndex, 1);
        reactions[existingIndex].count -= 1;
        if (reactions[existingIndex].count <= 0) {
          reactions.splice(existingIndex, 1);
        }
      } else {
        reactions[existingIndex].users.push(userId);
        reactions[existingIndex].count += 1;
      }
    } else {
      reactions.push({ emoji, count: 1, users: [userId] });
    }

    const updated = await this.commentRepo.updateTaskComment(commentId, {
      reactions: reactions as unknown as Prisma.InputJsonValue,
    });

    return { comment: updated };
  }

  async addTaskReply(commentId: string, userId: string, dto: AddReplyDto) {
    const [user, comment] = await Promise.all([
      this.commentRepo.findAuthorById(userId),
      this.commentRepo.findTaskCommentById(commentId),
    ]);

    if (!comment) throw new NotFoundException('Comment not found');

    const reply = this.buildReply(dto.content, user);
    const currentReplies = parseCommentReplies(comment.replies);
    const updatedReplies = [...currentReplies, reply];

    const updated = await this.commentRepo.updateTaskComment(commentId, {
      replies: updatedReplies as unknown as Prisma.InputJsonValue,
    });

    return { comment: updated, reply };
  }

  async deleteTaskReply(commentId: string, replyId: string) {
    const comment = await this.commentRepo.findTaskCommentById(commentId);
    if (!comment) throw new NotFoundException('Comment not found');

    const currentReplies = parseCommentReplies(comment.replies);
    const updatedReplies = currentReplies.filter((r) => r.id !== replyId);

    const updated = await this.commentRepo.updateTaskComment(commentId, {
      replies: updatedReplies as unknown as Prisma.InputJsonValue,
    });

    return { comment: updated };
  }
}
