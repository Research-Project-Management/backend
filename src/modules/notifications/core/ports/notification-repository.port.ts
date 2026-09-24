import { NotificationEntity } from '../domain/entities/notification.entity';

export interface QueryNotificationsOptions {
  isRead?: boolean;
  type?: string;
  limit?: number;
  offset?: number;
}

export interface INotificationRepositoryPort {
  save(notification: NotificationEntity): Promise<NotificationEntity>;
  findById(id: string): Promise<NotificationEntity | null>;
  findByKey(key: string, userId?: string): Promise<NotificationEntity | null>;
  findByUser(userId: string, options?: QueryNotificationsOptions): Promise<NotificationEntity[]>;
  countUnread(userId: string): Promise<number>;
  markAsRead(id: string, userId?: string): Promise<boolean>;
  markAllAsRead(userId: string): Promise<number>;
  deleteById(id: string, userId?: string): Promise<boolean>;
  deleteByKey(key: string, userId?: string): Promise<number>;
  deleteExpired(now?: Date): Promise<number>;
}

export const NOTIFICATION_REPOSITORY_PORT = Symbol('INotificationRepositoryPort');
