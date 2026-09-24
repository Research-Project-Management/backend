import { NotificationEntity } from '../domain/entities/notification.entity';

export interface IRealtimeNotifierPort {
  notifyUser(userId: string, notification: NotificationEntity, unreadCount: number): Promise<void>;
  broadcastUnreadCount(userId: string, unreadCount: number): Promise<void>;
}

export const REALTIME_NOTIFIER_PORT = Symbol('IRealtimeNotifierPort');
