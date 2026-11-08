import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CommentRepository } from './comment.repository';
import { ResourceAccessPolicy, Role } from '@/modules/project/access';
import {
  CreateCommentDto,
  UpdateCommentDto,
  AddReplyDto,
  ReactCommentDto,
} from './dto/comment.dto';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

export interface CommentAuthor {
  id: string;
  name: string;
  email?: string | null;
  avatar?: string | null;
}

export interface CommentReply {
  id: string;
  content: string;
  author: CommentAuthor | null;
  createdAt: string;
}

export function parseCommentReplies(raw: unknown): CommentReply[] {
  if (!raw || !Array.isArray(raw)) return [];
  const list: unknown[] = raw;
  return list.filter(
    (item: unknown): item is CommentReply =>
      typeof item === 'object' &&
      item !== null &&
      'id' in item &&
      typeof (item as Record<string, unknown>).id === 'string' &&
      'content' in item &&
      typeof (item as Record<string, unknown>).content === 'string',
  );
}

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
    @Optional() private readonly resourcePolicy?: ResourceAccessPolicy,
  ) {}

  private isProjectCreatorForComment(
    comment: {
      workItem?: {
        project?: { createdById?: string | null } | null;
      } | null;
    },
    userId: string,
  ): boolean {
    return comment.workItem?.project?.createdById === userId;
  }

  private async assertCanModifyComment(
    commentId: string,
    userId: string,
    action: 'update' | 'delete',
  ) {
    const comment =
      await this.commentRepository.findCommentWithProject(commentId);

    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    const projectId = comment.workItem?.projectId;
    let role = Role.CONTRIBUTOR;
    if (projectId) {
      const memberRole = await this.commentRepository.findProjectMemberRole(
        projectId,
        userId,
      );
      if (memberRole) {
        role = memberRole as Role;
      }
    }

    if (this.resourcePolicy) {
      this.resourcePolicy.assertCanModifyComment(
        { userId, role },
        { id: comment.id, authorId: comment.authorId },
        action,
      );
      return comment;
    }

    // Academic Integrity Fallback:
    // Update strictly requires comment author (prevents tampering with peer reviews)
    if (action === 'update') {
      if (comment.authorId !== userId) {
        throw new ForbiddenException(
          'Academic integrity violation: Only the original author can edit their own comment or review.',
        );
      }
      return comment;
    }

    // Delete allows author or owner moderation
    if (comment.authorId === userId || role === Role.OWNER || this.isProjectCreatorForComment(comment, userId)) {
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

  async getComments(workItemId: string) {
    const comments =
      await this.commentRepository.findWorkItemComments(workItemId);
    return { comments };
  }

  async createComment(
    workItemId: string,
    userId: string,
    createCommentDto: CreateCommentDto,
  ) {
    const comment = await this.commentRepository.createComment({
      workItemId,
      authorId: userId,
      content: createCommentDto.content,
      attachments:
        createCommentDto.attachments as unknown as Prisma.InputJsonValue,
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

  async updateComment(
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
        attachments:
          updateCommentDto.attachments as unknown as Prisma.InputJsonValue,
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

  async deleteComment(commentId: string, userId: string) {
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

  async addReply(
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

  async reactToComment(
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
}
