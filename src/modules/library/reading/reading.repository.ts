import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma, ReadStatus } from '@prisma/client';
import { ReadingStatus } from './types/reading.types';

@Injectable()
export class ReadingRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findItemInWorkspace(
    workspaceId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.catalogItem.findFirst({
      where: { id: itemId, workspaceId, deletedAt: null },
      select: { id: true, workspaceId: true, title: true },
    });
  }

  async findState(
    workspaceId: string,
    itemId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.userItemState.findUnique({
      where: {
        userId_itemId: {
          userId,
          itemId,
        },
      },
    });
  }

  async findStatesForItems(
    workspaceId: string,
    itemIds: string[],
    userId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.userItemState.findMany({
      where: {
        userId,
        itemId: { in: itemIds },
      },
    });
  }

  async upsertState(
    workspaceId: string,
    itemId: string,
    userId: string,
    data: {
      readStatus?: ReadingStatus;
      rating?: number;
      lastReadAt?: Date | null;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const dbReadStatus = data.readStatus
      ? (data.readStatus as unknown as ReadStatus)
      : undefined;

    return client.userItemState.upsert({
      where: {
        userId_itemId: {
          userId,
          itemId,
        },
      },
      create: {
        userId,
        itemId,
        readStatus: dbReadStatus ?? ReadStatus.unread,
        rating: data.rating ?? 0,
        lastReadAt:
          data.lastReadAt ??
          (data.readStatus === ReadingStatus.READING ||
          data.readStatus === ReadingStatus.COMPLETED
            ? new Date()
            : null),
      },
      update: {
        ...(dbReadStatus !== undefined ? { readStatus: dbReadStatus } : {}),
        ...(data.rating !== undefined ? { rating: data.rating } : {}),
        ...(data.lastReadAt !== undefined
          ? { lastReadAt: data.lastReadAt }
          : data.readStatus === ReadingStatus.READING ||
              data.readStatus === ReadingStatus.COMPLETED
            ? { lastReadAt: new Date() }
            : {}),
      },
    });
  }
}
