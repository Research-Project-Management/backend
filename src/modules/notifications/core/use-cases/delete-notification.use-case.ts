import { Inject, Injectable } from '@nestjs/common';
import {
  INotificationRepositoryPort,
  NOTIFICATION_REPOSITORY_PORT,
} from '../ports/notification-repository.port';
import {
  IRealtimeNotifierPort,
  REALTIME_NOTIFIER_PORT,
} from '../ports/realtime-notifier.port';

@Injectable()
export class DeleteNotificationUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY_PORT)
    private readonly repository: INotificationRepositoryPort,
    @Inject(REALTIME_NOTIFIER_PORT)
    private readonly notifier: IRealtimeNotifierPort
  ) {}

  async deleteById(id: string, userId?: string): Promise<boolean> {
    const existing = await this.repository.findById(id);
    if (!existing) return false;

    const targetUserId = userId ?? existing.userId;
    const deleted = await this.repository.deleteById(id, userId);

    if (deleted) {
      const count = await this.repository.countUnread(targetUserId);
      await this.notifier.broadcastUnreadCount(targetUserId, count);
    }

    return deleted;
  }

  async deleteByKey(key: string, userId?: string): Promise<number> {
    const deleted = await this.repository.deleteByKey(key, userId);
    if (deleted > 0 && userId) {
      const count = await this.repository.countUnread(userId);
      await this.notifier.broadcastUnreadCount(userId, count);
    }
    return deleted;
  }
}
