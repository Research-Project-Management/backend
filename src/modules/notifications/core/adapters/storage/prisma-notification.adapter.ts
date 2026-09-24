import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  INotificationRepositoryPort,
  QueryNotificationsOptions,
} from '../../ports/notification-repository.port';
import { NotificationEntity } from '../../domain/entities/notification.entity';
import { InMemoryNotificationAdapter } from './in-memory-notification.adapter';

@Injectable()
export class PrismaNotificationAdapter implements INotificationRepositoryPort {
  private readonly logger = new Logger(PrismaNotificationAdapter.name);
  private readonly memoryFallback = new InMemoryNotificationAdapter();

  constructor(private readonly prisma: PrismaService) {}

  async save(notification: NotificationEntity): Promise<NotificationEntity> {
    try {
      const data = {
        id: notification.id,
        userId: notification.userId,
        key: notification.key,
        templateKey: notification.templateKey,
        type: notification.type as any,
        projectId: notification.projectId,
        docId: notification.docId,
        actorId: notification.actorId,
        messageOpts: notification.messageOpts,
        isRead: notification.isRead,
        expiresAt: notification.expiresAt,
        createdAt: notification.createdAt,
        readAt: notification.readAt,
      };

      const record = await (this.prisma as any).manuscriptNotification.upsert({
        where: { id: notification.id },
        create: data,
        update: data,
      });

      return this.mapToEntity(record);
    } catch {
      return this.memoryFallback.save(notification);
    }
  }

  async findById(id: string): Promise<NotificationEntity | null> {
    try {
      const record = await (this.prisma as any).manuscriptNotification.findUnique({
        where: { id },
      });
      return record ? this.mapToEntity(record) : null;
    } catch {
      return this.memoryFallback.findById(id);
    }
  }

  async findByKey(key: string, userId?: string): Promise<NotificationEntity | null> {
    try {
      const where: any = { key };
      if (userId) where.userId = userId;

      const record = await (this.prisma as any).manuscriptNotification.findFirst({
        where,
        orderBy: { createdAt: 'desc' },
      });
      return record ? this.mapToEntity(record) : null;
    } catch {
      return this.memoryFallback.findByKey(key, userId);
    }
  }

  async findByUser(
    userId: string,
    options?: QueryNotificationsOptions
  ): Promise<NotificationEntity[]> {
    try {
      const now = new Date();
      const where: any = {
        userId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      };

      if (options?.isRead !== undefined) {
        where.isRead = options.isRead;
      }
      if (options?.type) {
        where.type = options.type;
      }

      const records = await (this.prisma as any).manuscriptNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: options?.offset ?? 0,
        take: options?.limit ?? 50,
      });

      return records.map((r: any) => this.mapToEntity(r));
    } catch {
      return this.memoryFallback.findByUser(userId, options);
    }
  }

  async countUnread(userId: string): Promise<number> {
    try {
      const now = new Date();
      return await (this.prisma as any).manuscriptNotification.count({
        where: {
          userId,
          isRead: false,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      });
    } catch {
      return this.memoryFallback.countUnread(userId);
    }
  }

  async markAsRead(id: string, userId?: string): Promise<boolean> {
    try {
      const where: any = { id };
      if (userId) where.userId = userId;

      const result = await (this.prisma as any).manuscriptNotification.updateMany({
        where,
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });
      return result.count > 0;
    } catch {
      return this.memoryFallback.markAsRead(id, userId);
    }
  }

  async markAllAsRead(userId: string): Promise<number> {
    try {
      const result = await (this.prisma as any).manuscriptNotification.updateMany({
        where: {
          userId,
          isRead: false,
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });
      return result.count;
    } catch {
      return this.memoryFallback.markAllAsRead(userId);
    }
  }

  async deleteById(id: string, userId?: string): Promise<boolean> {
    try {
      const where: any = { id };
      if (userId) where.userId = userId;

      const result = await (this.prisma as any).manuscriptNotification.deleteMany({
        where,
      });
      return result.count > 0;
    } catch {
      return this.memoryFallback.deleteById(id, userId);
    }
  }

  async deleteByKey(key: string, userId?: string): Promise<number> {
    try {
      const where: any = {
        key: {
          startsWith: key,
        },
      };
      if (userId) where.userId = userId;

      const result = await (this.prisma as any).manuscriptNotification.deleteMany({
        where,
      });
      return result.count;
    } catch {
      return this.memoryFallback.deleteByKey(key, userId);
    }
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    try {
      const result = await (this.prisma as any).manuscriptNotification.deleteMany({
        where: {
          expiresAt: {
            lte: now,
          },
        },
      });
      return result.count;
    } catch {
      return this.memoryFallback.deleteExpired(now);
    }
  }

  private mapToEntity(record: any): NotificationEntity {
    return new NotificationEntity({
      id: record.id,
      userId: record.userId,
      key: record.key,
      templateKey: record.templateKey,
      type: record.type,
      projectId: record.projectId,
      docId: record.docId,
      actorId: record.actorId,
      messageOpts: typeof record.messageOpts === 'object' ? record.messageOpts : {},
      isRead: record.isRead,
      expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
      createdAt: new Date(record.createdAt),
      readAt: record.readAt ? new Date(record.readAt) : null,
    });
  }
}
