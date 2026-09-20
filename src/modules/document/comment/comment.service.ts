import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  UnprocessableEntityException,
  Optional,
  Logger,
} from '@nestjs/common';
import { CommentRepository } from './comment.repository';
import {
  CreateCommentDto,
  UpdateCommentDto,
  AddReplyDto,
} from './dto/comment.dto';
import { CommentStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as Y from 'yjs';
import {
  parseCommentReplies,
  CommentReply,
  CommentAuthor,
} from './types/comment.types';
import { PrismaService } from '@/core/database/prisma.service';
import { sanitizeCommentContent } from '../page/utils/page.utils';
import { CollaborationGateway } from '../collaboration/collaboration.gateway';
import { YjsDocumentManager } from '../collaboration/yjs-document.manager';

/**
 * Parses @mention tokens from comment content.
 * Supports:
 *   - Rich-text: @[Display Name](userId)   → returns ['userId']
 */
function extractMentions(content: string): string[] {
  if (!content) return [];
  const rich = /@\[([^\]]+)\](?:\(([^)]+)\))?/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = rich.exec(content)) !== null) {
    const userId = match[2]?.trim();
    if (userId) mentions.push(userId);
  }

  return [...new Set(mentions)];
}

@Injectable()
export class CommentService {
  private readonly logger = new Logger(CommentService.name);

  constructor(
    private readonly commentRepo: CommentRepository,
    private readonly prisma: PrismaService,
    @Optional() private readonly collaborationGateway?: CollaborationGateway,
    @Optional() private readonly yjsManager?: YjsDocumentManager,
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

  async getComments(pageId: string, userId?: string) {
    if (!pageId) {
      return { comments: [] };
    }

    const page = await this.prisma.page.findFirst({
      where: { id: pageId, deletedAt: null },
      select: { id: true, projectId: true, authorId: true },
    });

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    if (userId && page.projectId) {
      const isCreator = page.authorId === userId;
      if (!isCreator) {
        const member = await this.prisma.projectMember.findUnique({
          where: {
            projectId_userId: { projectId: page.projectId, userId },
          },
        });
        if (!member) {
          throw new ForbiddenException(
            'You do not have permission to view comments on this page',
          );
        }
      }
    }

    const comments = await this.commentRepo.findComments(pageId);
    return { comments };
  }

  async createComment(pageId: string, userId: string, dto: CreateCommentDto) {
    const cleanContent = sanitizeCommentContent(dto.content);
    if (!cleanContent) {
      throw new UnprocessableEntityException('Comment content cannot be empty');
    }

    const page = await this.prisma.page.findFirst({
      where: { id: pageId, deletedAt: null },
      select: { id: true, parentPageId: true, projectId: true, authorId: true },
    });

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    if (userId && page.projectId) {
      const isCreator = page.authorId === userId;
      if (!isCreator) {
        const member = await this.prisma.projectMember.findUnique({
          where: {
            projectId_userId: { projectId: page.projectId, userId },
          },
        });
        if (!member) {
          throw new ForbiddenException(
            'You do not have permission to comment on this document',
          );
        }
      }
    }

    const comment = await this.commentRepo.createComment({
      pageId,
      projectPageId: page.parentPageId || null,
      authorId: userId,
      content: cleanContent,
      status: dto.status || CommentStatus.open,
      line: dto.line,
      lineEnd: dto.lineEnd,
      yjsAnchorStart: dto.yjsAnchorStart || null,
      yjsAnchorEnd: dto.yjsAnchorEnd || null,
      selectedText: dto.selectedText || null,
    });

    this.collaborationGateway?.broadcastRoomEvent(pageId, 'comment:created', {
      pageId,
      comment,
    });

    const mentions = extractMentions(cleanContent);
    if (mentions.length > 0) {
      this.collaborationGateway?.broadcastRoomEvent(pageId, 'comment:mention', {
        pageId,
        commentId: comment.id,
        authorId: userId,
        mentionedUserIds: mentions,
        content: cleanContent,
      });
    }

    return { comment };
  }

  async updateComment(
    commentId: string,
    userId: string,
    dto: UpdateCommentDto,
  ) {
    const existing = await this.assertCanModifyComment(
      commentId,
      userId,
      'update',
    );

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

    const targetPageId = comment.pageId || existing.pageId;
    this.collaborationGateway?.broadcastRoomEvent(
      targetPageId,
      'comment:updated',
      {
        pageId: targetPageId,
        comment,
      },
    );

    return { comment };
  }

  async deleteComment(commentId: string, userId: string) {
    const existing = await this.assertCanModifyComment(
      commentId,
      userId,
      'delete',
    );

    await this.commentRepo.deleteComment(commentId);

    this.collaborationGateway?.broadcastRoomEvent(
      existing.pageId,
      'comment:deleted',
      {
        pageId: existing.pageId,
        commentId,
        deletedBy: userId,
      },
    );

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

    const targetPageId = comment.pageId || existing.pageId;
    this.collaborationGateway?.broadcastRoomEvent(
      targetPageId,
      'comment:replied',
      {
        pageId: targetPageId,
        commentId,
        reply: newReply,
        comment,
      },
    );

    const replyMentions = extractMentions(cleanContent);
    if (replyMentions.length > 0) {
      this.collaborationGateway?.broadcastRoomEvent(
        targetPageId,
        'comment:mention',
        {
          pageId: targetPageId,
          commentId,
          replyId: newReply.id,
          authorId: userId,
          mentionedUserIds: replyMentions,
          content: cleanContent,
        },
      );
    }

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

    this.collaborationGateway?.broadcastRoomEvent(
      existing.pageId,
      'comment:reply-deleted',
      {
        pageId: existing.pageId,
        commentId,
        replyId,
        comment,
      },
    );

    return { comment };
  }

  /**
   * Resolves Yjs relative positions (yjsAnchorStart/End) for all open comments on a page
   * to current absolute character indices and line numbers.
   *
   * Use this endpoint to re-anchor comments in the frontend after receiving
   * a `comment:anchors-shifted` event from the collaboration gateway.
   * Falls back to stored line/lineEnd numbers if no Yjs session is active.
   */
  async resolveAllAnchors(pageId: string): Promise<
    Array<{
      commentId: string;
      anchorStart: { charIndex: number; line: number } | null;
      anchorEnd: { charIndex: number; line: number } | null;
      selectedText: string | null;
      hasYjsAnchor: boolean;
    }>
  > {
    const comments = await this.commentRepo.findComments(pageId);
    const session = this.yjsManager?.hasActiveSession(pageId)
      ? await this.yjsManager.getOrCreateDoc(pageId)
      : null;

    return comments.map((comment: any) => {
      let anchorStart: { charIndex: number; line: number } | null = null;
      let anchorEnd: { charIndex: number; line: number } | null = null;
      const hasYjsAnchor =
        Boolean(comment.yjsAnchorStart) || Boolean(comment.yjsAnchorEnd);

      if (session && comment.yjsAnchorStart) {
        try {
          const relPos = Y.createRelativePositionFromJSON(
            JSON.parse(comment.yjsAnchorStart),
          );
          const absPos = Y.createAbsolutePositionFromRelativePosition(
            relPos,
            session.doc,
          );
          if (absPos !== null) {
            const textBefore = session.yText.toJSON().slice(0, absPos.index);
            const line = textBefore.split('\n').length;
            anchorStart = { charIndex: absPos.index, line };
          }
        } catch (err: any) {
          this.logger.debug(
            `[Comment] Failed to resolve yjsAnchorStart for comment ${comment.id}: ${err?.message}`,
          );
          // Fallback to stored line number
          if (comment.line != null) {
            anchorStart = { charIndex: -1, line: comment.line };
          }
        }
      } else if (comment.line != null) {
        anchorStart = { charIndex: -1, line: comment.line };
      }

      if (session && comment.yjsAnchorEnd) {
        try {
          const relPos = Y.createRelativePositionFromJSON(
            JSON.parse(comment.yjsAnchorEnd),
          );
          const absPos = Y.createAbsolutePositionFromRelativePosition(
            relPos,
            session.doc,
          );
          if (absPos !== null) {
            const textBefore = session.yText.toJSON().slice(0, absPos.index);
            const line = textBefore.split('\n').length;
            anchorEnd = { charIndex: absPos.index, line };
          }
        } catch (err: any) {
          this.logger.debug(
            `[Comment] Failed to resolve yjsAnchorEnd for comment ${comment.id}: ${err?.message}`,
          );
          if (comment.lineEnd != null) {
            anchorEnd = { charIndex: -1, line: comment.lineEnd };
          }
        }
      } else if (comment.lineEnd != null) {
        anchorEnd = { charIndex: -1, line: comment.lineEnd };
      }

      return {
        commentId: comment.id,
        anchorStart,
        anchorEnd,
        selectedText: comment.selectedText ?? null,
        hasYjsAnchor,
      };
    });
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
