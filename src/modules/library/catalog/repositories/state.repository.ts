import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, ReadStatus } from '@prisma/client';
import {
  StateEntity,
  UpsertStateData,
} from '@/modules/library/catalog/types/state.types';
import { pickPreferredMergedState } from '@/modules/library/catalog/domain/state.domain';
import { normalizeProjectScopeId } from '@/modules/library/core';

const STATE_SELECT = {
  userId: true,
  itemId: true,
  isStarred: true,
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
    projectId?: string,
  ): Promise<StateEntity[]> {
    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    return client.state.findMany({
      where: {
        userId,
        itemId: { in: itemIds },
        ...(validProjectId
          ? { item: { projectId: validProjectId, deletedAt: null } }
          : {}),
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
        isStarred: data.isStarred ?? false,
        readStatus: dbReadStatus,
        rating: data.rating,
        currentPage: data.currentPage ?? 1,
        scrollPosition: scrollJson ?? Prisma.JsonNull,
        lastOpenedAt: data.lastOpenedAt ?? new Date(),
        lastReadAt: data.lastReadAt,
      },
      update: {
        isStarred: data.isStarred,
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

  async transferItemStates(
    sourceItemIds: string[],
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;
    const cleanSourceIds = sourceItemIds.filter((id) => id !== targetItemId);
    if (cleanSourceIds.length === 0) return;

    const client = this.getClient(tx);
    const allUserStates = await client.state.findMany({
      where: { itemId: { in: [targetItemId, ...cleanSourceIds] } },
    });

    const userStateByUser = new Map<string, typeof allUserStates>();
    for (const us of allUserStates) {
      const list = userStateByUser.get(us.userId) || [];
      list.push(us);
      userStateByUser.set(us.userId, list);
    }

    await Promise.all(
      Array.from(userStateByUser.entries()).map(([userId, states]) => {
        const merged = pickPreferredMergedState(states);
        const scrollJson =
          merged.latestScroll !== undefined && merged.latestScroll !== null
            ? (merged.latestScroll as Prisma.InputJsonValue)
            : undefined;

        return client.state.upsert({
          where: {
            userId_itemId: {
              userId,
              itemId: targetItemId,
            },
          },
          create: {
            userId,
            itemId: targetItemId,
            isStarred: merged.isStarred,
            rating: merged.maxRating,
            readStatus: merged.readStatus as Prisma.StateUncheckedCreateInput['readStatus'],
            currentPage: merged.maxCurrentPage,
            scrollPosition: scrollJson ?? Prisma.JsonNull,
            lastOpenedAt: merged.latestOpenedAt,
            lastReadAt: merged.latestReadAt,
          },
          update: {
            isStarred: merged.isStarred,
            rating: merged.maxRating,
            readStatus: merged.readStatus as Prisma.StateUncheckedUpdateInput['readStatus'],
            currentPage: merged.maxCurrentPage,
            scrollPosition: scrollJson,
            lastOpenedAt: merged.latestOpenedAt ?? undefined,
            lastReadAt: merged.latestReadAt ?? undefined,
          },
        });
      }),
    );

    await client.state.deleteMany({
      where: { itemId: { in: cleanSourceIds } },
    });
  }
}
