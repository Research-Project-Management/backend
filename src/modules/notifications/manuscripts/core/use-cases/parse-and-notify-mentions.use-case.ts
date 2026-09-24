import { Inject, Injectable } from '@nestjs/common';
import {
  IMentionParserPort,
  MENTION_PARSER_PORT,
} from '../ports/mention-parser.port';
import { CreateNotificationUseCase } from '../../../../notifications/core/use-cases/create-notification.use-case';
import { NotificationEntity } from '../../../../notifications/core/domain/entities/notification.entity';
import { MentionToken } from '../domain/value-objects/mention-token.vo';

export interface ParseAndNotifyMentionsCommand {
  text: string;
  actorId: string;
  actorName?: string;
  projectId: string;
  projectName?: string;
  docId?: string;
  threadId?: string;
  commentId?: string;
  // Map of handle/email (lowercase) -> userId
  collaboratorMap?: Record<string, string>;
}

export interface ParseMentionsResult {
  tokens: MentionToken[];
  dispatchedNotifications: NotificationEntity[];
}

@Injectable()
export class ParseAndNotifyMentionsUseCase {
  constructor(
    @Inject(MENTION_PARSER_PORT)
    private readonly mentionParser: IMentionParserPort,
    private readonly createNotificationUseCase: CreateNotificationUseCase
  ) {}

  async execute(command: ParseAndNotifyMentionsCommand): Promise<ParseMentionsResult> {
    const tokens = this.mentionParser.extractMentions(command.text);
    const dispatched: NotificationEntity[] = [];

    if (tokens.length === 0) {
      return { tokens, dispatchedNotifications: dispatched };
    }

    const collaboratorMap = command.collaboratorMap ?? {};
    const processedUserIds = new Set<string>();

    for (const token of tokens) {
      const handleLower = token.handle.toLowerCase();
      // Lookup user ID from collaborator map (or default to handle if mapped)
      const recipientUserId = collaboratorMap[handleLower];

      if (!recipientUserId) {
        // Collaborator not found in project member map
        continue;
      }

      // Avoid notifying self or duplicate recipients
      if (recipientUserId === command.actorId || processedUserIds.has(recipientUserId)) {
        continue;
      }
      processedUserIds.add(recipientUserId);

      const snippet = command.text.length > 140 ? `${command.text.slice(0, 137)}...` : command.text;
      const refId = command.commentId || command.threadId || 'general';
      const idempotencyKey = `comment-mention-${refId}-${recipientUserId}`;

      const notification = await this.createNotificationUseCase.execute({
        userId: recipientUserId,
        key: idempotencyKey,
        templateKey: 'notification_comment_mention',
        type: 'mention',
        projectId: command.projectId,
        docId: command.docId,
        actorId: command.actorId,
        messageOpts: {
          actorId: command.actorId,
          actorName: command.actorName ?? 'A collaborator',
          projectId: command.projectId,
          projectName: command.projectName ?? 'Manuscript',
          threadId: command.threadId,
          commentId: command.commentId,
          snippet,
          handle: token.handle,
        },
        forceCreate: false, // Idempotent: don't recreate if already notified for this comment
      });

      dispatched.push(notification);
    }

    return {
      tokens,
      dispatchedNotifications: dispatched,
    };
  }
}
