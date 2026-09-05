import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReadingRepository } from './reading.repository';
import { UpdateReadingDto } from './dto/update-reading.dto';
import { ReadingState, ReadingStatus } from './types/reading.types';

@Injectable()
export class ReadingService {
  constructor(private readonly readingRepository: ReadingRepository) {}

  private toResponse(
    state?: {
      readStatus: string;
      rating: number | null;
      lastReadAt: Date | null;
    } | null,
  ): ReadingState {
    return {
      readStatus: (state?.readStatus as ReadingStatus) ?? ReadingStatus.UNREAD,
      rating: state?.rating ?? 0,
      lastReadAt: state?.lastReadAt ? state.lastReadAt.toISOString() : null,
    };
  }

  async getState(
    workspaceId: string,
    itemId: string,
    userId: string,
  ): Promise<ReadingState> {
    await this.assertItemExists(workspaceId, itemId);
    const state = await this.readingRepository.findState(
      workspaceId,
      itemId,
      userId,
    );
    return this.toResponse(state);
  }

  async updateState(
    workspaceId: string,
    itemId: string,
    userId: string,
    dto: UpdateReadingDto,
  ): Promise<ReadingState> {
    await this.assertItemExists(workspaceId, itemId);
    const updated = await this.readingRepository.upsertState(
      workspaceId,
      itemId,
      userId,
      {
        readStatus: dto.readStatus,
        rating: dto.rating,
      },
    );

    return this.toResponse(updated);
  }

  async markAsRead(
    workspaceId: string,
    itemId: string,
    userId: string,
  ): Promise<ReadingState> {
    await this.assertItemExists(workspaceId, itemId);
    const existing = await this.readingRepository.findState(
      workspaceId,
      itemId,
      userId,
    );
    const nextStatus =
      existing?.readStatus === ReadingStatus.COMPLETED
        ? ReadingStatus.COMPLETED
        : ReadingStatus.READING;

    const updated = await this.readingRepository.upsertState(
      workspaceId,
      itemId,
      userId,
      {
        readStatus: nextStatus,
        lastReadAt: new Date(),
      },
    );

    return this.toResponse(updated);
  }

  private async assertItemExists(
    workspaceId: string,
    itemId: string,
  ): Promise<void> {
    const item = await this.readingRepository.findItemInWorkspace(
      workspaceId,
      itemId,
    );
    if (!item) {
      throw new NotFoundException(`Item not found in workspace ${workspaceId}`);
    }
  }

  async getBatchStates(
    workspaceId: string,
    itemIds: string[],
    userId: string,
  ): Promise<Record<string, ReadingState>> {
    if (!itemIds.length) return {};

    const states = await this.readingRepository.findStatesForItems(
      workspaceId,
      itemIds,
      userId,
    );

    const resultMap: Record<string, ReadingState> = {};
    for (const id of itemIds) {
      resultMap[id] = this.toResponse(null);
    }

    for (const st of states) {
      resultMap[st.itemId] = this.toResponse(st);
    }

    return resultMap;
  }

  /**
   * Domain merge helper: consolidates UserItemState records from duplicate items to a target item,
   * preserving highest rating, most complete read status, and latest read timestamp.
   */
  async transferUserItemStates(
    tx: Prisma.TransactionClient,
    sourceItemIds: string[],
    targetItemId: string,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;

    const allUserStates = await tx.userItemState.findMany({
      where: { itemId: { in: [targetItemId, ...sourceItemIds] } },
    });

    const userStateByUser = new Map<string, typeof allUserStates>();
    for (const us of allUserStates) {
      const list = userStateByUser.get(us.userId) || [];
      list.push(us);
      userStateByUser.set(us.userId, list);
    }

    for (const [userId, states] of userStateByUser.entries()) {
      const maxRating = Math.max(...states.map((s) => s.rating || 0));
      const isCompleted = states.some((s) => s.readStatus === 'completed');
      const isReading = states.some((s) => s.readStatus === 'reading');
      const readStatus = isCompleted
        ? 'completed'
        : isReading
          ? 'reading'
          : 'unread';
      const latestReadAt = states
        .map((s) => s.lastReadAt)
        .filter((d): d is Date => d !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0];

      await tx.userItemState.upsert({
        where: {
          userId_itemId: {
            userId,
            itemId: targetItemId,
          },
        },
        create: {
          userId,
          itemId: targetItemId,
          rating: maxRating,
          readStatus,
          lastReadAt: latestReadAt || null,
        },
        update: {
          rating: maxRating,
          readStatus,
          lastReadAt: latestReadAt || undefined,
        },
      });
    }

    await tx.userItemState.deleteMany({
      where: { itemId: { in: sourceItemIds } },
    });
  }
}
