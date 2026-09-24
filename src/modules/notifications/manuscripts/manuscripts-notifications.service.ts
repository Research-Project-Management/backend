/**
 * modules/notifications/manuscripts/manuscripts-notifications.service.ts
 * Specialized Notification Service for Manuscripts domain (LaTeX Comments, Mentions, Thread Resolution).
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  ParseAndNotifyMentionsUseCase,
  ParseAndNotifyMentionsCommand,
  ParseMentionsResult,
} from './core/use-cases/parse-and-notify-mentions.use-case';
import {
  IMentionParserPort,
  MENTION_PARSER_PORT,
} from './core/ports/mention-parser.port';
import { MentionToken } from './core/domain/value-objects/mention-token.vo';
import { CreateNotificationUseCase } from '../core/use-cases/create-notification.use-case';
import { DeleteNotificationUseCase } from '../core/use-cases/delete-notification.use-case';
import { NotificationEntity } from '../core/domain/entities/notification.entity';

export interface CommentMentionNotificationDto {
  recipientUserId: string;
  actorId: string;
  actorName: string;
  projectId: string;
  projectName?: string;
  docId?: string;
  threadId: string;
  commentId?: string;
  snippet: string;
}

export interface CommentReplyNotificationDto {
  recipientUserId: string;
  actorId: string;
  actorName: string;
  projectId: string;
  projectName?: string;
  docId?: string;
  threadId: string;
  replyId: string;
  snippet: string;
}

export interface ThreadResolvedNotificationDto {
  recipientUserId: string;
  actorId: string;
  actorName: string;
  projectId: string;
  projectName?: string;
  docId?: string;
  threadId: string;
  quote?: string;
}

@Injectable()
export class ManuscriptsNotificationsService {
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
    const refId = dto.commentId || dto.threadId;
    return this.createNotificationUseCase.execute({
      userId: dto.recipientUserId,
      key: `comment-mention-${refId}-${dto.recipientUserId}`,
      templateKey: 'notification_comment_mention',
      type: 'mention',
      projectId: dto.projectId,
      docId: dto.docId,
      actorId: dto.actorId,
      messageOpts: {
        actorId: dto.actorId,
        actorName: dto.actorName,
        projectId: dto.projectId,
        projectName: dto.projectName || 'Manuscript',
        threadId: dto.threadId,
        commentId: dto.commentId,
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
    return this.createNotificationUseCase.execute({
      userId: dto.recipientUserId,
      key: `comment-reply-${dto.replyId}-${dto.recipientUserId}`,
      templateKey: 'comment_reply',
      type: 'comment_reply',
      projectId: dto.projectId,
      docId: dto.docId,
      actorId: dto.actorId,
      messageOpts: {
        actorId: dto.actorId,
        actorName: dto.actorName,
        projectId: dto.projectId,
        projectName: dto.projectName || 'Manuscript',
        threadId: dto.threadId,
        commentId: dto.replyId,
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
    return this.createNotificationUseCase.execute({
      userId: dto.recipientUserId,
      key: `thread-resolved-${dto.threadId}-${dto.recipientUserId}`,
      templateKey: 'thread_resolved',
      type: 'thread_resolved',
      projectId: dto.projectId,
      docId: dto.docId,
      actorId: dto.actorId,
      messageOpts: {
        actorId: dto.actorId,
        actorName: dto.actorName,
        projectId: dto.projectId,
        projectName: dto.projectName || 'Manuscript',
        threadId: dto.threadId,
        quote: dto.quote,
      },
    });
  }

  /**
   * Dismisses mention and reply notifications when thread is resolved.
   */
  async dismissThreadNotifications(threadId: string): Promise<number> {
    return this.deleteNotificationUseCase.deleteByKey(
      `comment-mention-${threadId}`,
    );
  }
}
