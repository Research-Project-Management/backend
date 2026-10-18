import { Injectable, Logger, Optional } from '@nestjs/common';
import { IRealtimeNotifierPort } from '../../ports/realtime-notifier.port';
import { NotificationEntity } from '../../domain/entities/notification.entity';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';

export interface DispatchedNotificationPayload {
  unreadCount?: number;
  notification?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DispatchedNotificationEvent {
  userId: string;
  type: 'notification:new' | 'notification:count';
  payload: DispatchedNotificationPayload;
  timestamp: Date;
}

@Injectable()
export class EventRealtimeNotifierAdapter implements IRealtimeNotifierPort {
  private readonly logger = new Logger(EventRealtimeNotifierAdapter.name);
  public readonly dispatchedEvents: DispatchedNotificationEvent[] = [];

  constructor(@Optional() private readonly realtimeService?: RealtimeFacade) {}

  async notifyUser(
    userId: string,
    notification: NotificationEntity,
    unreadCount: number,
  ): Promise<void> {
    const payload = {
      notification: notification.toPlain(),
      unreadCount,
    };

    this.dispatchedEvents.push({
      userId,
      type: 'notification:new',
      payload,
      timestamp: new Date(),
    });

    try {
      if (this.realtimeService) {
        this.realtimeService.notifyUser(userId, 'notification:new', payload);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `Could not push realtime websocket alert to user:${userId}: ${errMsg}`,
      );
    }
  }

  async broadcastUnreadCount(
    userId: string,
    unreadCount: number,
  ): Promise<void> {
    const payload = { unreadCount };

    this.dispatchedEvents.push({
      userId,
      type: 'notification:count',
      payload,
      timestamp: new Date(),
    });

    try {
      if (this.realtimeService) {
        this.realtimeService.notifyUser(userId, 'notification:count', payload);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `Could not broadcast unread count to user:${userId}: ${errMsg}`,
      );
    }
  }

  clearDispatchedEvents(): void {
    this.dispatchedEvents.length = 0;
  }
}
