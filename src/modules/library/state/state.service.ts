import {
  Injectable,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StateRepository } from './state.repository';
import { UpdateStateDto } from './dto/state.dto';
import { StateData, ReadingStatus } from './types/state.types';
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

import { toStateResponse } from './utils/state.utils';

@Injectable()
export class StateService {
  constructor(
    private readonly stateRepository: StateRepository,
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
  ): StateData {
    return toStateResponse(state);
  }

  async getState(
    rawWorkspaceId: string,
    itemId: string,
    userId: string,
  ): Promise<StateData> {
    const workspaceId = await this.resolveWorkspaceId(rawWorkspaceId);
    await this.assertItemExists(workspaceId, itemId);
    const state = await this.stateRepository.findState(
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
    dto: UpdateStateDto,
  ): Promise<StateData> {
    const workspaceId = await this.resolveWorkspaceId(rawWorkspaceId);
    await this.assertItemExists(workspaceId, itemId);

    const execute = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => {
      const updated = await this.stateRepository.upsertState(
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
        entityType: 'State',
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

    const updated = await this.stateRepository.upsertState(
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
  ): Promise<StateData> {
    const workspaceId = await this.resolveWorkspaceId(rawWorkspaceId);
    await this.assertItemExists(workspaceId, itemId);
    const existing = await this.stateRepository.findState(
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
      const updated = await this.stateRepository.upsertState(
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
        entityType: 'State',
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

    const updated = await this.stateRepository.upsertState(
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
      const item = await this.prisma.item.findFirst({
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
  ): Promise<Record<string, StateData>> {
    if (!itemIds.length) return {};
    const workspaceId = await this.resolveWorkspaceId(rawWorkspaceId);

    const states = await this.stateRepository.findStatesForItems(
      workspaceId,
      itemIds,
      userId,
    );

    const resultMap: Record<string, StateData> = {};
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

    const allUserStates = await tx.state.findMany({
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

      await tx.state.upsert({
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

    await tx.state.deleteMany({
      where: { itemId: { in: sourceItemIds } },
    });
  }
}

export const ReadingService = StateService;
export type ReadingService = StateService;
