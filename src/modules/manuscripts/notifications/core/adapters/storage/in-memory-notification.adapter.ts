import { Injectable } from '@nestjs/common';
import {
  INotificationRepositoryPort,
  QueryNotificationsOptions,
} from '../../ports/notification-repository.port';
import { NotificationEntity } from '../../domain/entities/notification.entity';

@Injectable()
export class InMemoryNotificationAdapter implements INotificationRepositoryPort {
  private notifications: Map<string, NotificationEntity> = new Map();

  async save(notification: NotificationEntity): Promise<NotificationEntity> {
    this.notifications.set(notification.id, notification);
    return notification;
  }

  async findById(id: string): Promise<NotificationEntity | null> {
    const item = this.notifications.get(id);
    return item ?? null;
  }

  async findByKey(key: string, userId?: string): Promise<NotificationEntity | null> {
    for (const item of this.notifications.values()) {
      if (item.key === key && (!userId || item.userId === userId)) {
        return item;
      }
    }
    return null;
  }

  async findByUser(
    userId: string,
    options?: QueryNotificationsOptions
  ): Promise<NotificationEntity[]> {
    const now = new Date();
    let items = Array.from(this.notifications.values()).filter(
      (n) => n.userId === userId && !n.isExpired(now)
    );

    if (options?.isRead !== undefined) {
      items = items.filter((n) => n.isRead === options.isRead);
    }
    if (options?.type) {
      items = items.filter((n) => n.type === options.type);
    }

    // Sort by createdAt desc
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (options?.offset) {
      items = items.slice(options.offset);
    }
    if (options?.limit) {
      items = items.slice(0, options.limit);
    }

    return items;
  }

  async countUnread(userId: string): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const item of this.notifications.values()) {
      if (item.userId === userId && !item.isRead && !item.isExpired(now)) {
        count++;
      }
    }
    return count;
  }

  async markAsRead(id: string, userId?: string): Promise<boolean> {
    const item = this.notifications.get(id);
    if (!item) return false;
    if (userId && item.userId !== userId) return false;

    item.markAsRead();
    this.notifications.set(id, item);
    return true;
  }

  async markAllAsRead(userId: string): Promise<number> {
    let updated = 0;
    for (const [id, item] of this.notifications.entries()) {
      if (item.userId === userId && !item.isRead) {
        item.markAsRead();
        this.notifications.set(id, item);
        updated++;
      }
    }
    return updated;
  }

  async deleteById(id: string, userId?: string): Promise<boolean> {
    const item = this.notifications.get(id);
    if (!item) return false;
    if (userId && item.userId !== userId) return false;

    return this.notifications.delete(id);
  }

  async deleteByKey(key: string, userId?: string): Promise<number> {
    let deleted = 0;
    for (const [id, item] of this.notifications.entries()) {
      if (item.key === key && (!userId || item.userId === userId)) {
        this.notifications.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    let count = 0;
    for (const [id, item] of this.notifications.entries()) {
      if (item.isExpired(now)) {
        this.notifications.delete(id);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.notifications.clear();
  }
}
