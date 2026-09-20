import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { Prisma, ReadStatus } from '@prisma/client';
import { StateEntity, UpsertStateData } from '../../domain/types/state.types';

const STATE_SELECT = {
  id: true,
  userId: true,
  itemId: true,
  readStatus: true,
  rating: true,
  currentPage: true,
  scrollPosition: true,
  lastOpenedAt: true,
  lastReadAt: true,
  updatedAt: true,
} satisfies Prisma.StateSelect;

@Injectable()
export class StateRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findState(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<StateEntity | null> {
    const client = this.getClient(tx);
    return client.state.findUnique({
      where: {
        userId_itemId: {
          userId,
          itemId,
        },
      },
      select: STATE_SELECT,
    });
  }

  async findStatesForItems(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<StateEntity[]> {
    const client = this.getClient(tx);
    return client.state.findMany({
      where: {
        userId,
        itemId: { in: itemIds },
      },
      select: STATE_SELECT,
    });
  }

  async upsertState(
    userId: string,
    itemId: string,
    data: UpsertStateData,
    tx?: Prisma.TransactionClient,
  ): Promise<StateEntity> {
    const client = this.getClient(tx);
    const dbReadStatus = data.readStatus
      ? (data.readStatus as unknown as ReadStatus)
      : undefined;

    const scrollJson =
      data.scrollPosition !== undefined
        ? data.scrollPosition !== null
          ? (data.scrollPosition as Prisma.InputJsonValue)
          : Prisma.JsonNull
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
        currentPage: data.currentPage ?? 1,
        scrollPosition: scrollJson ?? Prisma.JsonNull,
        lastOpenedAt: data.lastOpenedAt ?? new Date(),
        lastReadAt: data.lastReadAt,
      },
      update: {
        readStatus: dbReadStatus,
        rating: data.rating,
        currentPage: data.currentPage,
        scrollPosition: scrollJson,
        lastOpenedAt: data.lastOpenedAt,
        lastReadAt: data.lastReadAt,
      },
      select: STATE_SELECT,
    });
  }

  async deleteState(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ count: number }> {
    const client = this.getClient(tx);
    return client.state.deleteMany({
      where: {
        userId,
        itemId,
      },
    });
  }
}
