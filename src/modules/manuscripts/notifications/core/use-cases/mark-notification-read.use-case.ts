import { Inject, Injectable } from '@nestjs/common';
import {
  INotificationRepositoryPort,
  NOTIFICATION_REPOSITORY_PORT,
} from '../ports/notification-repository.port';
import {
  IRealtimeNotifierPort,
  REALTIME_NOTIFIER_PORT,
} from '../ports/realtime-notifier.port';
import { NotificationNotFoundException } from '../domain/exceptions/notification-not-found.exception';

@Injectable()
export class MarkNotificationReadUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY_PORT)
    private readonly repository: INotificationRepositoryPort,
    @Inject(REALTIME_NOTIFIER_PORT)
    private readonly notifier: IRealtimeNotifierPort
  ) {}

  async execute(notificationId: string, userId?: string): Promise<boolean> {
    const existing = await this.repository.findById(notificationId);
    if (!existing) {
      throw new NotificationNotFoundException(notificationId);
    }

    if (userId && existing.userId !== userId) {
      throw new NotificationNotFoundException(notificationId);
    }

    const updated = await this.repository.markAsRead(notificationId, userId);
    if (updated) {
      const targetUserId = userId ?? existing.userId;
      const unreadCount = await this.repository.countUnread(targetUserId);
      await this.notifier.broadcastUnreadCount(targetUserId, unreadCount);
    }

    return updated;
  }
}
