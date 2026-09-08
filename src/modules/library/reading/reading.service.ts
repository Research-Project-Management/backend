import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReadingRepository } from './reading.repository';
import { UpdateReadingDto } from './dto/reading.dto';
import { ReadingState, ReadingStatus } from './types/reading.types';
import {
  TransactionService,
  TransactionHelpers,
} from '../outbox/transaction.service';
import { LIBRARY_EVENT_TYPES } from '../outbox/outbox.events';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveTenantWorkspaceId } from '../../../core/utils/tenant.util';
import {
  ITEM_EXISTENCE_PORT,
  IItemExistencePort,
} from '../items/ports/items.ports';
import { Inject } from '@nestjs/common';

import { toReadingStateResponse } from './utils/reading.utils';

@Injectable()
export class ReadingService {
  constructor(
    private readonly readingRepository: ReadingRepository,
    @Optional() private readonly libraryTx?: TransactionService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional()
    @Inject(ITEM_EXISTENCE_PORT)
    private readonly itemExistencePort?: IItemExistencePort,
  ) {}

  private resolveWorkspaceId(workspaceId: string): Promise<string> {
    if (!this.prisma) return Promise.resolve(workspaceId);
    return resolveTenantWorkspaceId(this.prisma, workspaceId);
  }

  private toResponse(
    state?: {
      readStatus: string;
      rating: number | null;
      lastReadAt: Date | null;
    } | null,
  ): ReadingState {
    return toReadingStateResponse(state);
  }

  async getState(
    rawWorkspaceId: string,
    itemId: string,
    userId: string,
  ): Promise<ReadingState> {
    const workspaceId = await this.resolveWorkspaceId(rawWorkspaceId);
    await this.assertItemExists(workspaceId, itemId);
    const state = await this.readingRepository.findState(
      workspaceId,
      itemId,
      userId,
    );
    return this.toResponse(state);
  }

  async updateState(
    rawWorkspaceId: string,
    itemId: string,
    userId: string,
    dto: UpdateReadingDto,
  ): Promise<ReadingState> {
    const workspaceId = await this.resolveWorkspaceId(rawWorkspaceId);
    await this.assertItemExists(workspaceId, itemId);

    const execute = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => {
      const updated = await this.readingRepository.upsertState(
        workspaceId,
        itemId,
        userId,
        {
          readStatus: dto.readStatus,
          rating: dto.rating,
        },
        tx,
      );

      await helpers.appendChange(workspaceId, {
        entityType: 'UserItemState',
        entityId: `${userId}:${itemId}`,
        action: 'update',
        version: 1,
        data: updated,
      });

      await helpers.publishOutbox(
        workspaceId,
        itemId,
        LIBRARY_EVENT_TYPES.READING_STATE_UPDATED,
        {
          itemId,
          userId,
          workspaceId,
          readStatus: updated.readStatus,
          rating: updated.rating,
          lastReadAt: updated.lastReadAt,
        },
      );

      return this.toResponse(updated);
    };

    if (this.libraryTx) {
      return this.libraryTx.executeInTransaction(execute);
    }

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
    rawWorkspaceId: string,
    itemId: string,
    userId: string,
  ): Promise<ReadingState> {
    const workspaceId = await this.resolveWorkspaceId(rawWorkspaceId);
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

    const execute = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => {
      const updated = await this.readingRepository.upsertState(
        workspaceId,
        itemId,
        userId,
        {
          readStatus: nextStatus,
          lastReadAt: new Date(),
        },
        tx,
      );

      await helpers.appendChange(workspaceId, {
        entityType: 'UserItemState',
        entityId: `${userId}:${itemId}`,
        action: 'update',
        version: 1,
        data: updated,
      });

      await helpers.publishOutbox(
        workspaceId,
        itemId,
        LIBRARY_EVENT_TYPES.READING_STATE_UPDATED,
        {
          itemId,
          userId,
          workspaceId,
          readStatus: updated.readStatus,
          rating: updated.rating,
          lastReadAt: updated.lastReadAt,
        },
      );

      return this.toResponse(updated);
    };

    if (this.libraryTx) {
      return this.libraryTx.executeInTransaction(execute);
    }

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
    if (this.itemExistencePort) {
      await this.itemExistencePort.assertExists(workspaceId, itemId);
      return;
    }
    if (this.prisma) {
      const item = await this.prisma.catalogItem.findFirst({
        where: { id: itemId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!item) {
        throw new NotFoundException(
          `Item not found in workspace ${workspaceId}`,
        );
      }
      return;
    }
    throw new NotFoundException(`Item not found in workspace ${workspaceId}`);
  }

  async getBatchStates(
    rawWorkspaceId: string,
    itemIds: string[],
    userId: string,
  ): Promise<Record<string, ReadingState>> {
    if (!itemIds.length) return {};
    const workspaceId = await this.resolveWorkspaceId(rawWorkspaceId);

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
