import { Inject, Injectable } from '@nestjs/common';
import {
  CreateNotificationUseCase,
  CreateNotificationCommand,
} from './core/use-cases/create-notification.use-case';
import { GetUserNotificationsUseCase } from './core/use-cases/get-user-notifications.use-case';
import { GetUnreadCountUseCase } from './core/use-cases/get-unread-count.use-case';
import { MarkNotificationReadUseCase } from './core/use-cases/mark-notification-read.use-case';
import { MarkAllReadUseCase } from './core/use-cases/mark-all-read.use-case';
import { DeleteNotificationUseCase } from './core/use-cases/delete-notification.use-case';
import {
  ParseAndNotifyMentionsUseCase,
  ParseAndNotifyMentionsCommand,
  ParseMentionsResult,
} from './core/use-cases/parse-and-notify-mentions.use-case';
import {
  IMentionParserPort,
  MENTION_PARSER_PORT,
} from './core/ports/mention-parser.port';
import { QueryNotificationsOptions } from './core/ports/notification-repository.port';
import { NotificationEntity } from './core/domain/entities/notification.entity';
import { MentionToken } from './core/domain/value-objects/mention-token.vo';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly createNotificationUseCase: CreateNotificationUseCase,
    private readonly getUserNotificationsUseCase: GetUserNotificationsUseCase,
    private readonly getUnreadCountUseCase: GetUnreadCountUseCase,
    private readonly markNotificationReadUseCase: MarkNotificationReadUseCase,
    private readonly markAllReadUseCase: MarkAllReadUseCase,
    private readonly deleteNotificationUseCase: DeleteNotificationUseCase,
    private readonly parseAndNotifyMentionsUseCase: ParseAndNotifyMentionsUseCase,
    @Inject(MENTION_PARSER_PORT)
    private readonly mentionParser: IMentionParserPort
  ) {}

  async createNotification(command: CreateNotificationCommand): Promise<NotificationEntity> {
    return this.createNotificationUseCase.execute(command);
  }

  async getUserNotifications(
    userId: string,
    options?: QueryNotificationsOptions
  ): Promise<NotificationEntity[]> {
    return this.getUserNotificationsUseCase.execute(userId, options);
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.getUnreadCountUseCase.execute(userId);
  }

  async markAsRead(notificationId: string, userId?: string): Promise<boolean> {
    return this.markNotificationReadUseCase.execute(notificationId, userId);
  }

  async markAllAsRead(userId: string): Promise<number> {
    return this.markAllReadUseCase.execute(userId);
  }

  async deleteById(id: string, userId?: string): Promise<boolean> {
    return this.deleteNotificationUseCase.deleteById(id, userId);
  }

  async deleteByKey(key: string, userId?: string): Promise<number> {
    return this.deleteNotificationUseCase.deleteByKey(key, userId);
  }

  async parseAndNotifyMentions(
    command: ParseAndNotifyMentionsCommand
  ): Promise<ParseMentionsResult> {
    return this.parseAndNotifyMentionsUseCase.execute(command);
  }

  extractMentions(text: string): MentionToken[] {
    return this.mentionParser.extractMentions(text);
  }
}
