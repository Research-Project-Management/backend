import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma, ReadStatus } from '@prisma/client';
import { ReadingStatus } from './types/state.types';

@Injectable()
export class StateRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findState(
    workspaceId: string,
    itemId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.state.findUnique({
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
    return client.state.findMany({
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

    return client.state.upsert({
      where: {
        userId_itemId: {
          userId,
          itemId,
        },
      },
      create: {
        userId,
        itemId,
        readStatus: dbReadStatus,
        rating: data.rating,
        lastReadAt: data.lastReadAt,
      },
      update: {
        readStatus: dbReadStatus,
        rating: data.rating,
        lastReadAt: data.lastReadAt,
      },
    });
  }

  async deleteState(
    workspaceId: string,
    itemId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.state.deleteMany({
      where: {
        userId,
        itemId,
      },
    });
  }
}

export const ReadingRepository = StateRepository;
export type ReadingRepository = StateRepository;
