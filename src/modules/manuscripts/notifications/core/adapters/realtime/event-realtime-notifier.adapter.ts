import { Injectable, Logger, Optional } from '@nestjs/common';
import { IRealtimeNotifierPort } from '../../ports/realtime-notifier.port';
import { NotificationEntity } from '../../domain/entities/notification.entity';
import { ManuscriptRealtimeGateway } from '@/modules/manuscripts/realtime/realtime.gateway';

export interface DispatchedNotificationEvent {
  userId: string;
  type: 'notification:new' | 'notification:count';
  payload: any;
  timestamp: Date;
}

@Injectable()
export class EventRealtimeNotifierAdapter implements IRealtimeNotifierPort {
  private readonly logger = new Logger(EventRealtimeNotifierAdapter.name);
  public readonly dispatchedEvents: DispatchedNotificationEvent[] = [];

  constructor(@Optional() private readonly realtimeGateway?: ManuscriptRealtimeGateway) {}

  async notifyUser(
    userId: string,
    notification: NotificationEntity,
    unreadCount: number
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
      if (this.realtimeGateway && typeof (this.realtimeGateway as any).server?.to === 'function') {
        (this.realtimeGateway as any).server
          .to(`user:${userId}`)
          .emit('notification:new', payload);
      }
    } catch (err: any) {
      this.logger.debug(`Could not push realtime websocket alert to user:${userId}: ${err?.message}`);
    }
  }

  async broadcastUnreadCount(userId: string, unreadCount: number): Promise<void> {
    const payload = { unreadCount };

    this.dispatchedEvents.push({
      userId,
      type: 'notification:count',
      payload,
      timestamp: new Date(),
    });

    try {
      if (this.realtimeGateway && typeof (this.realtimeGateway as any).server?.to === 'function') {
        (this.realtimeGateway as any).server
          .to(`user:${userId}`)
          .emit('notification:count', payload);
      }
    } catch (err: any) {
      this.logger.debug(`Could not broadcast unread count to user:${userId}: ${err?.message}`);
    }
  }

  clearDispatchedEvents(): void {
    this.dispatchedEvents.length = 0;
  }
}
