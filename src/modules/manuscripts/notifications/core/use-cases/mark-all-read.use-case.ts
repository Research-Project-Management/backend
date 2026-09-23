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
export class MarkAllReadUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY_PORT)
    private readonly repository: INotificationRepositoryPort,
    @Inject(REALTIME_NOTIFIER_PORT)
    private readonly notifier: IRealtimeNotifierPort
  ) {}

  async execute(userId: string): Promise<number> {
    if (!userId || !userId.trim()) {
      return 0;
    }

    const count = await this.repository.markAllAsRead(userId);
    await this.notifier.broadcastUnreadCount(userId, 0);
    return count;
  }
}
