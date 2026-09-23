import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  INotificationRepositoryPort,
  NOTIFICATION_REPOSITORY_PORT,
} from '../ports/notification-repository.port';
import {
  IRealtimeNotifierPort,
  REALTIME_NOTIFIER_PORT,
} from '../ports/realtime-notifier.port';
import { NotificationEntity } from '../domain/entities/notification.entity';
import { NotificationType, NotificationTypeString } from '../domain/value-objects/notification-type.vo';
import { InvalidNotificationException } from '../domain/exceptions/invalid-notification.exception';

export interface CreateNotificationCommand {
  userId: string;
  key?: string;
  templateKey: string;
  type?: NotificationTypeString;
  projectId?: string;
  docId?: string;
  actorId?: string;
  messageOpts?: Record<string, any>;
  expiresAt?: Date | string;
  forceCreate?: boolean;
}

@Injectable()
export class CreateNotificationUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY_PORT)
    private readonly repository: INotificationRepositoryPort,
    @Inject(REALTIME_NOTIFIER_PORT)
    private readonly notifier: IRealtimeNotifierPort
  ) {}

  async execute(command: CreateNotificationCommand): Promise<NotificationEntity> {
    if (!command.userId || !command.userId.trim()) {
      throw new InvalidNotificationException('userId must not be empty');
    }
    if (!command.templateKey || !command.templateKey.trim()) {
      throw new InvalidNotificationException('templateKey must not be empty');
    }

    const type = command.type ?? 'mention';
    if (!NotificationType.isValid(type)) {
      throw new InvalidNotificationException(`type '${type}' is invalid`);
    }

    // Overleaf parity: If key is provided and forceCreate is false, check existing
    if (command.key && command.forceCreate === false) {
      const existing = await this.repository.findByKey(command.key, command.userId);
      if (existing) {
        return existing;
      }
    }

    let parsedExpiresAt: Date | null = null;
    if (command.expiresAt) {
      parsedExpiresAt =
        command.expiresAt instanceof Date ? command.expiresAt : new Date(command.expiresAt);
      if (isNaN(parsedExpiresAt.getTime())) {
        throw new InvalidNotificationException('expiresAt must be a valid date or ISO string');
      }
    }

    const entity = new NotificationEntity({
      id: randomUUID(),
      userId: command.userId,
      key: command.key ?? null,
      templateKey: command.templateKey,
      type,
      projectId: command.projectId ?? null,
      docId: command.docId ?? null,
      actorId: command.actorId ?? null,
      messageOpts: command.messageOpts ?? {},
      isRead: false,
      expiresAt: parsedExpiresAt,
      createdAt: new Date(),
    });

    const saved = await this.repository.save(entity);

    // Broadcast realtime badge update
    const unreadCount = await this.repository.countUnread(command.userId);
    await this.notifier.notifyUser(command.userId, saved, unreadCount);

    return saved;
  }
}
