import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import {
  ManuscriptNotification,
  ManuscriptNotificationType,
  Prisma,
} from '@prisma/client';
import {
  INotificationRepositoryPort,
  QueryNotificationsOptions,
} from '../../ports/notification-repository.port';
import { NotificationEntity } from '../../domain/entities/notification.entity';

@Injectable()
export class PrismaNotificationAdapter implements INotificationRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async save(notification: NotificationEntity): Promise<NotificationEntity> {
    const data = {
      id: notification.id,
      userId: notification.userId,
      key: notification.key,
      templateKey: notification.templateKey,
      type: notification.type,
      projectId: notification.projectId,
      docId: notification.docId,
      actorId: notification.actorId,
      messageOpts: (notification.messageOpts ?? {}) as Prisma.InputJsonObject,
      isRead: notification.isRead,
      expiresAt: notification.expiresAt,
      createdAt: notification.createdAt,
      readAt: notification.readAt,
    };

    const record = await this.prisma.manuscriptNotification.upsert({
      where: { id: notification.id },
      create: data,
      update: data,
    });

    return this.mapToEntity(record);
  }

  async findById(id: string): Promise<NotificationEntity | null> {
    const record = await this.prisma.manuscriptNotification.findUnique({
      where: { id },
    });
    return record ? this.mapToEntity(record) : null;
  }

  async findByKey(
    key: string,
    userId?: string,
  ): Promise<NotificationEntity | null> {
    const where: Prisma.ManuscriptNotificationWhereInput = { key };
    if (userId) where.userId = userId;

    const record = await this.prisma.manuscriptNotification.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
    });
    return record ? this.mapToEntity(record) : null;
  }

  async findAffectedUserIdsByKey(
    key: string,
    userId?: string,
  ): Promise<string[]> {
    if (!this.prisma.manuscriptNotification?.findMany) {
      return userId ? [userId] : [];
    }
    const where: Prisma.ManuscriptNotificationWhereInput = {
      key: {
        startsWith: key,
      },
    };
    if (userId) where.userId = userId;

    const records = await this.prisma.manuscriptNotification
      .findMany({
        where,
        select: { userId: true },
      })
      .catch(() => []);
    return Array.from(
      new Set(
        records
          .map((r) => r.userId)
          .filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
      ),
    );
  }

  async findByUser(
    userId: string,
    options?: QueryNotificationsOptions,
  ): Promise<NotificationEntity[]> {
    const now = new Date();
    const where: Prisma.ManuscriptNotificationWhereInput = {
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };

    if (options?.isRead !== undefined) {
      where.isRead = options.isRead;
    }
    if (options?.type) {
      where.type = options.type as ManuscriptNotificationType;
    }

    const records = await this.prisma.manuscriptNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: options?.offset ?? 0,
      take: options?.limit ?? 50,
    });

    return records.map((r) => this.mapToEntity(r));
  }

  async countUnread(userId: string): Promise<number> {
    const now = new Date();
    return this.prisma.manuscriptNotification.count({
      where: {
        userId,
        isRead: false,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  }

  async markAsRead(id: string, userId?: string): Promise<boolean> {
    const where: Prisma.ManuscriptNotificationWhereInput = { id };
    if (userId) where.userId = userId;

    const result = await this.prisma.manuscriptNotification.updateMany({
      where,
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
    return result.count > 0;
  }

  async markAllAsRead(userId: string): Promise<number> {
    const result = await this.prisma.manuscriptNotification.updateMany({
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
  }

  async deleteById(id: string, userId?: string): Promise<boolean> {
    const where: Prisma.ManuscriptNotificationWhereInput = { id };
    if (userId) where.userId = userId;

    const result = await this.prisma.manuscriptNotification.deleteMany({
      where,
    });
    return result.count > 0;
  }

  async deleteByKey(key: string, userId?: string): Promise<number> {
    const where: Prisma.ManuscriptNotificationWhereInput = {
      key: {
        startsWith: key,
      },
    };
    if (userId) where.userId = userId;

    const result = await this.prisma.manuscriptNotification.deleteMany({
      where,
    });
    return result.count;
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.manuscriptNotification.deleteMany({
      where: {
        expiresAt: {
          lte: now,
        },
      },
    });
    return result.count;
  }

  private mapToEntity(record: ManuscriptNotification): NotificationEntity {
    return new NotificationEntity({
      id: record.id,
      userId: record.userId,
      key: record.key,
      templateKey: record.templateKey,
      type: record.type,
      projectId: record.projectId,
      docId: record.docId,
      actorId: record.actorId,
      messageOpts:
        record.messageOpts &&
        typeof record.messageOpts === 'object' &&
        !Array.isArray(record.messageOpts)
          ? record.messageOpts
          : undefined,
      isRead: record.isRead,
      expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
      createdAt: new Date(record.createdAt),
      readAt: record.readAt ? new Date(record.readAt) : null,
    });
  }
}
