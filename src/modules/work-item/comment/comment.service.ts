import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CommentRepository } from './comment.repository';
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

/**
 * Parses @mention tokens from comment content.
 *
 * Supports two formats:
 *   - Rich-text: @[Display Name](userId)   → returns ['userId']
 *   - Plain-text: @userId                  → returns ['userId'] (fallback)
 */
function extractMentions(content: string): string[] {
  const rich = /@\[([^\]]+)\]\(([^)]+)\)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = rich.exec(content)) !== null) {
    const userId = match[2]?.trim();
    if (userId) mentions.push(userId);
  }

  // Deduplicate
  return [...new Set(mentions)];
}

@Injectable()
export class CommentService {
  constructor(
    private readonly commentRepository: CommentRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  private async assertCanModifyComment(
    commentId: string,
    userId: string,
    action: string,
  ) {
    const comment =
      await this.commentRepository.findCommentWithProject(commentId);

    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    if (comment.authorId === userId) {
      return comment;
    }

    const workItem = comment.workItem;

    if (workItem?.project?.createdById === userId) {
      return comment;
    }

    if (workItem?.projectId) {
      const projectRole = await this.commentRepository.findProjectMemberRole(
        workItem.projectId,
        userId,
      );
      if (projectRole === 'owner') {
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

  async getWorkItemComments(workItemId: string) {
    const comments =
      await this.commentRepository.findWorkItemComments(workItemId);
    return { comments };
  }

  async createWorkItemComment(
    workItemId: string,
    userId: string,
    createCommentDto: CreateCommentDto,
  ) {
    const comment = await this.commentRepository.createComment({
      workItemId,
      authorId: userId,
      content: createCommentDto.content,
      attachments: createCommentDto.attachments,
    });

    // Emit mention events for each @mentioned user
    const mentions = extractMentions(createCommentDto.content);
    if (mentions.length > 0 && this.eventEmitter) {
      this.eventEmitter.emit('comment.mention', {
        workItemId,
        commentId: comment.id,
        authorId: userId,
        mentionedUserIds: mentions,
      });
    }

    this.eventEmitter?.emit('comment.created', {
      workItemId,
      commentId: comment.id,
      authorId: userId,
      content: comment.content,
    });

    return { comment };
  }

  async updateWorkItemComment(
    commentId: string,
    userId: string,
    updateCommentDto: UpdateCommentDto,
  ) {
    await this.assertCanModifyComment(commentId, userId, 'update');

    const comment = await this.commentRepository.updateComment(commentId, {
      ...(updateCommentDto.content !== undefined && {
        content: updateCommentDto.content,
      }),
      ...(updateCommentDto.attachments !== undefined && {
        attachments: updateCommentDto.attachments,
      }),
      isEdited: true,
    });

    this.eventEmitter?.emit('comment.updated', {
      workItemId: comment?.workItemId,
      commentId: comment?.id,
      authorId: userId,
    });

    return { comment };
  }

  async deleteWorkItemComment(commentId: string, userId: string) {
    const existing = await this.assertCanModifyComment(
      commentId,
      userId,
      'delete',
    );

    await this.commentRepository.deleteComment(commentId);

    this.eventEmitter?.emit('comment.deleted', {
      workItemId: existing.workItemId,
      commentId,
      authorId: userId,
    });

    return { success: true };
  }

  async addWorkItemReply(
    commentId: string,
    userId: string,
    addReplyDto: AddReplyDto,
  ) {
    const existing = await this.commentRepository.findCommentById(commentId);
    if (!existing) {
      throw new NotFoundException('Comment not found');
    }

    const author = await this.commentRepository.findAuthorById(userId);
    const replies = parseCommentReplies(existing.replies);
    const newReply = this.buildReply(addReplyDto.content, author);
    replies.push(newReply);

    const comment = await this.commentRepository.updateComment(commentId, {
      replies: replies as unknown as Prisma.InputJsonValue,
    });

    return { comment };
  }

  async reactToWorkItemComment(
    commentId: string,
    userId: string,
    reactCommentDto: ReactCommentDto,
  ) {
    const existing = await this.commentRepository.findCommentById(commentId);
    if (!existing) {
      throw new NotFoundException('Comment not found');
    }

    const reactions = (existing.reactions as Record<string, string[]>) || {};
    const users = reactions[reactCommentDto.emoji] || [];
    const index = users.indexOf(userId);

    if (index > -1) {
      users.splice(index, 1);
    } else {
      users.push(userId);
    }

    reactions[reactCommentDto.emoji] = users;

    const comment = await this.commentRepository.updateComment(commentId, {
      reactions: reactions,
    });

    return { comment };
  }

  getComments = this.getWorkItemComments.bind(this);
  createComment = this.createWorkItemComment.bind(this);
  updateComment = this.updateWorkItemComment.bind(this);
  deleteComment = this.deleteWorkItemComment.bind(this);
  addReply = this.addWorkItemReply.bind(this);
  reactComment = this.reactToWorkItemComment.bind(this);
}
