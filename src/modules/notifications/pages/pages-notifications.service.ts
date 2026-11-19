/**
 * modules/notifications/pages/pages-notifications.service.ts
 * Specialized Notification Service for Pages domain (LaTeX Comments, Mentions, Thread Resolution).
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  ParseAndNotifyMentionsUseCase,
  ParseAndNotifyMentionsCommand,
  ParseMentionsResult,
} from '../core/use-cases/parse-and-notify-mentions.use-case';
import {
  IMentionParserPort,
  MENTION_PARSER_PORT,
} from '../core/ports/mention-parser.port';
import { MentionToken } from '../core/domain/value-objects/mention-token.vo';
import { CreateNotificationUseCase } from '../core/use-cases/create-notification.use-case';
import { DeleteNotificationUseCase } from '../core/use-cases/delete-notification.use-case';
import { NotificationEntity } from '../core/domain/entities/notification.entity';

export interface CommentMentionNotificationDto {
  recipientUserId: string;
  actorId: string;
  actorName: string;
  spaceId?: string | null;
  projectId?: string | null;
  projectName?: string;
  pageId?: string | null;
  docId?: string;
  threadId: string;
  commentId?: string;
  snippet: string;
  isPersonalSpace?: boolean;
}

export interface CommentReplyNotificationDto {
  recipientUserId: string;
  actorId: string;
  actorName: string;
  spaceId?: string | null;
  projectId?: string | null;
  projectName?: string;
  pageId?: string | null;
  docId?: string;
  threadId: string;
  replyId: string;
  snippet: string;
  isPersonalSpace?: boolean;
}

export interface ThreadResolvedNotificationDto {
  recipientUserId: string;
  actorId: string;
  actorName: string;
  spaceId?: string | null;
  projectId?: string | null;
  projectName?: string;
  pageId?: string | null;
  docId?: string;
  threadId: string;
  quote?: string;
  isPersonalSpace?: boolean;
}

export interface ReviewSuggestionNotificationDto {
  recipientUserId: string;
  actorId: string;
  actorName: string;
  spaceId?: string | null;
  projectId?: string | null;
  projectName?: string;
  pageId?: string | null;
  docId?: string;
  changeId: string;
  changeType: 'insert' | 'delete';
  snippet: string;
  line?: number;
  isPersonalSpace?: boolean;
}

@Injectable()
export class PagesNotificationsService {
  constructor(
    private readonly parseAndNotifyMentionsUseCase: ParseAndNotifyMentionsUseCase,
    @Inject(MENTION_PARSER_PORT)
    private readonly mentionParser: IMentionParserPort,
    private readonly createNotificationUseCase: CreateNotificationUseCase,
    private readonly deleteNotificationUseCase: DeleteNotificationUseCase,
  ) {}

  /**
   * Parses text for @mention tokens and dispatches notifications to project collaborators.
   */
  async parseAndNotifyMentions(
    command: ParseAndNotifyMentionsCommand,
  ): Promise<ParseMentionsResult> {
    return this.parseAndNotifyMentionsUseCase.execute(command);
  }

  /**
   * Pure mention extractor.
   */
  extractMentions(text: string): MentionToken[] {
    return this.mentionParser.extractMentions(text);
  }

  /**
   * Dispatches direct comment mention notification.
   */
  async notifyCommentMention(
    dto: CommentMentionNotificationDto,
  ): Promise<NotificationEntity> {
    const refKey = dto.commentId
      ? `${dto.threadId}-${dto.commentId}`
      : dto.threadId;
    const effectiveSpaceId = dto.spaceId ?? dto.projectId ?? null;
    const effectiveProjectId = dto.isPersonalSpace
      ? null
      : (dto.projectId ?? null);
    return this.createNotificationUseCase.execute({
      userId: dto.recipientUserId,
      key: `comment-mention-${refKey}-${dto.recipientUserId}`,
      templateKey: 'notification_comment_mention',
      type: 'mention',
      spaceId: effectiveSpaceId,
      projectId: effectiveProjectId,
      docId: dto.docId ?? null,
      actorId: dto.actorId,
      messageOpts: {
        actorId: dto.actorId,
        actorName: dto.actorName,
        spaceId: effectiveSpaceId,
        projectId: effectiveProjectId,
        projectName: dto.projectName || 'Manuscript',
        pageId: dto.pageId ?? undefined,
        docId: dto.docId ?? undefined,
        threadId: dto.threadId,
        commentId: dto.commentId,
        isPersonalSpace: Boolean(dto.isPersonalSpace),
        snippet: dto.snippet.slice(0, 140),
      },
    });
  }

  /**
   * Dispatches notification when someone replies to a user's comment thread.
   */
  async notifyCommentReply(
    dto: CommentReplyNotificationDto,
  ): Promise<NotificationEntity> {
    const effectiveSpaceId = dto.spaceId ?? dto.projectId ?? null;
    const effectiveProjectId = dto.isPersonalSpace
      ? null
      : (dto.projectId ?? null);
    return this.createNotificationUseCase.execute({
      userId: dto.recipientUserId,
      key: `comment-reply-${dto.threadId}-${dto.replyId}-${dto.recipientUserId}`,
      templateKey: 'comment_reply',
      type: 'comment_reply',
      spaceId: effectiveSpaceId,
      projectId: effectiveProjectId,
      docId: dto.docId ?? null,
      actorId: dto.actorId,
      messageOpts: {
        actorId: dto.actorId,
        actorName: dto.actorName,
        spaceId: effectiveSpaceId,
        projectId: effectiveProjectId,
        projectName: dto.projectName || 'Manuscript',
        pageId: dto.pageId ?? undefined,
        docId: dto.docId ?? undefined,
        threadId: dto.threadId,
        commentId: dto.replyId,
        isPersonalSpace: Boolean(dto.isPersonalSpace),
        eventType: 'reply',
        snippet: dto.snippet.slice(0, 140),
      },
    });
  }

  /**
   * Dispatches notification when a comment thread is resolved.
   */
  async notifyThreadResolved(
    dto: ThreadResolvedNotificationDto,
  ): Promise<NotificationEntity> {
    const effectiveSpaceId = dto.spaceId ?? dto.projectId ?? null;
    const effectiveProjectId = dto.isPersonalSpace
      ? null
      : (dto.projectId ?? null);
    return this.createNotificationUseCase.execute({
      userId: dto.recipientUserId,
      key: `thread-resolved-${dto.threadId}-${dto.recipientUserId}`,
      templateKey: 'thread_resolved',
      type: 'thread_resolved',
      spaceId: effectiveSpaceId,
      projectId: effectiveProjectId,
      docId: dto.docId ?? null,
      actorId: dto.actorId,
      messageOpts: {
        actorId: dto.actorId,
        actorName: dto.actorName,
        spaceId: effectiveSpaceId,
        projectId: effectiveProjectId,
        projectName: dto.projectName || 'Manuscript',
        pageId: dto.pageId ?? undefined,
        docId: dto.docId ?? undefined,
        threadId: dto.threadId,
        isPersonalSpace: Boolean(dto.isPersonalSpace),
        quote: dto.quote,
      },
    });
  }

  /**
   * Dispatches notification when a track-change review suggestion is created.
   */
  async notifyReviewSuggestion(
    dto: ReviewSuggestionNotificationDto,
  ): Promise<NotificationEntity> {
    const effectiveSpaceId = dto.spaceId ?? dto.projectId ?? null;
    const effectiveProjectId = dto.isPersonalSpace
      ? null
      : (dto.projectId ?? null);
    return this.createNotificationUseCase.execute({
      userId: dto.recipientUserId,
      key: `review-suggestion-${dto.changeId}-${dto.recipientUserId}`,
      templateKey: 'review_suggestion',
      type: 'review_request',
      spaceId: effectiveSpaceId,
      projectId: effectiveProjectId,
      docId: dto.docId ?? null,
      actorId: dto.actorId,
      messageOpts: {
        actorId: dto.actorId,
        actorName: dto.actorName,
        spaceId: effectiveSpaceId,
        projectId: effectiveProjectId,
        projectName: dto.projectName || 'Manuscript',
        pageId: dto.pageId ?? undefined,
        docId: dto.docId ?? undefined,
        changeId: dto.changeId,
        changeType: dto.changeType,
        eventType: 'suggestion',
        line: dto.line,
        isPersonalSpace: Boolean(dto.isPersonalSpace),
        snippet: dto.snippet.slice(0, 140),
      },
    });
  }

  /**
   * Dismisses thread-resolved notifications when a comment thread is reopened.
   */
  async dismissThreadResolved(
    threadId: string,
    userId?: string,
  ): Promise<number> {
    if (!threadId || !threadId.trim()) return 0;
    return this.deleteNotificationUseCase.deleteByKey(
      `thread-resolved-${threadId.trim()}`,
      userId,
    );
  }

  /**
   * Dismisses mention and reply notifications when thread is resolved.
   */
  async dismissThreadNotifications(threadId: string): Promise<number> {
    if (!threadId || !threadId.trim()) {
      return 0;
    }
    const safeThreadId = threadId.trim();
    const [deletedMentions, deletedReplies] = await Promise.all([
      this.deleteNotificationUseCase.deleteByKey(
        `comment-mention-${safeThreadId}`,
      ),
      this.deleteNotificationUseCase.deleteByKey(
        `comment-reply-${safeThreadId}`,
      ),
    ]);
    return deletedMentions + deletedReplies;
  }
}

export { PagesNotificationsService as ManuscriptsNotificationsService };
