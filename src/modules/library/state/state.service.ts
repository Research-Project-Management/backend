import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
  Inject,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StateRepository } from './state.repository';
import { UpdateStateDto } from './dto/state.dto';
import {
  StateData,
  ReadingStatus,
  StateEntity,
  UpsertStateData,
} from './types/state.types';
import {
  TransactionService,
  TransactionHelpers,
} from '../outbox/transaction.service';
import { LIBRARY_EVENT_TYPES } from '../outbox/outbox.events';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  ITEM_EXISTENCE_PORT,
  IItemExistencePort,
} from '../items/ports/items.ports';
import {
  toStateResponse,
  isValidRating,
  isValidCurrentPage,
  shouldAutoAdvanceToReading,
  isValidStateTransition,
} from './utils/state.utils';

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

  private toResponse(state?: StateEntity | null): StateData {
    return toStateResponse(state);
  }

  async getState(userId: string, itemId: string): Promise<StateData> {
    await this.assertItemExists(userId, itemId);

    const state = await this.stateRepository.findState(userId, itemId);

    return this.toResponse(state);
  }

  async updateState(
    userId: string,
    itemId: string,
    dto: UpdateStateDto,
  ): Promise<StateData> {
    await this.assertItemExists(userId, itemId);

    if (dto.rating !== undefined && !isValidRating(dto.rating)) {
      throw new BadRequestException(
        'rating must be an integer between 0 and 5',
      );
    }
    if (dto.currentPage !== undefined && !isValidCurrentPage(dto.currentPage)) {
      throw new BadRequestException('currentPage must be an integer >= 1');
    }

    const existing = await this.stateRepository.findState(userId, itemId);

    const currentStatus =
      (existing?.readStatus as ReadingStatus) ?? ReadingStatus.UNREAD;
    let targetStatus = dto.readStatus ?? currentStatus;

    // Domain rule: auto-advance to reading if unread and moved forward in document
    if (
      dto.readStatus === undefined &&
      shouldAutoAdvanceToReading(
        currentStatus,
        dto.currentPage,
        dto.scrollPosition,
      )
    ) {
      targetStatus = ReadingStatus.READING;
    }

    // Validate state transition if status is being updated
    if (dto.readStatus && dto.readStatus !== currentStatus) {
      if (!isValidStateTransition(currentStatus, dto.readStatus)) {
        throw new BadRequestException(
          `Invalid state transition from ${currentStatus} to ${dto.readStatus}`,
        );
      }
    }

    const now = new Date();
    const isNowReadingOrCompleted =
      targetStatus === ReadingStatus.READING ||
      targetStatus === ReadingStatus.COMPLETED;

    const upsertData: UpsertStateData = {
      readStatus: targetStatus,
      rating: dto.rating,
      currentPage: dto.currentPage,
      scrollPosition: dto.scrollPosition,
      lastOpenedAt: now,
      lastReadAt: isNowReadingOrCompleted
        ? (existing?.lastReadAt ?? now)
        : undefined,
    };

    const execute = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => {
      const updated = await this.stateRepository.upsertState(
        userId,
        itemId,
        upsertData,
        tx,
      );

      await helpers.appendChange(userId, {
        entityType: 'State',
        entityId: `${userId}:${itemId}`,
        action: 'update',
        version: 1,
        data: updated,
      });

      await helpers.publishOutbox(
        userId,
        itemId,
        LIBRARY_EVENT_TYPES.READING_STATE_UPDATED,
        {
          itemId,
          userId,
          readStatus: updated.readStatus,
          rating: updated.rating,
          currentPage: updated.currentPage,
          scrollPosition: updated.scrollPosition,
          lastOpenedAt: updated.lastOpenedAt,
          lastReadAt: updated.lastReadAt,
        },
      );

      return this.toResponse(updated);
    };

    if (this.libraryTx) {
      return this.libraryTx.executeInTransaction(execute);
    }

    const updated = await this.stateRepository.upsertState(
      userId,
      itemId,
      upsertData,
    );

    return this.toResponse(updated);
  }

  async markAsRead(userId: string, itemId: string): Promise<StateData> {
    await this.assertItemExists(userId, itemId);
    const existing = await this.stateRepository.findState(userId, itemId);

    const nextStatus =
      existing?.readStatus === ReadingStatus.COMPLETED
        ? ReadingStatus.COMPLETED
        : ReadingStatus.READING;

    const now = new Date();
    const execute = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => {
      const updated = await this.stateRepository.upsertState(
        userId,
        itemId,
        {
          readStatus: nextStatus,
          lastReadAt: now,
          lastOpenedAt: now,
        },
        tx,
      );

      await helpers.appendChange(userId, {
        entityType: 'State',
        entityId: `${userId}:${itemId}`,
        action: 'update',
        version: 1,
        data: updated,
      });

      await helpers.publishOutbox(
        userId,
        itemId,
        LIBRARY_EVENT_TYPES.READING_STATE_UPDATED,
        {
          itemId,
          userId,
          readStatus: updated.readStatus,
          rating: updated.rating,
          currentPage: updated.currentPage,
          scrollPosition: updated.scrollPosition,
          lastOpenedAt: updated.lastOpenedAt,
          lastReadAt: updated.lastReadAt,
        },
      );

      return this.toResponse(updated);
    };

    if (this.libraryTx) {
      return this.libraryTx.executeInTransaction(execute);
    }

    const updated = await this.stateRepository.upsertState(userId, itemId, {
      readStatus: nextStatus,
      lastReadAt: now,
      lastOpenedAt: now,
    });

    return this.toResponse(updated);
  }

  private async assertItemExists(
    userId: string,
    itemId: string,
  ): Promise<void> {
    if (this.itemExistencePort) {
      await this.itemExistencePort.assertExists(userId, itemId);
      return;
    }
    if (this.prisma) {
      const item = await this.prisma.item.findFirst({
        where: {
          id: itemId,
          userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!item) {
        throw new NotFoundException(`Item not found: ${itemId}`);
      }
      return;
    }
    throw new NotFoundException(`Item not found: ${itemId}`);
  }

  async getBatchStates(
    userId: string,
    itemIds: string[],
  ): Promise<Record<string, StateData>> {
    if (!itemIds.length) return {};

    const states = await this.stateRepository.findStatesForItems(
      userId,
      itemIds,
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
   * preserving highest rating, most complete read status, latest read timestamp, and farthest progress.
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

      const latestOpenedAt = states
        .map((s) => s.lastOpenedAt)
        .filter((d): d is Date => d !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0];

      const maxCurrentPage = Math.max(...states.map((s) => s.currentPage || 1));
      const latestScroll = states.find(
        (s) => s.scrollPosition !== null,
      )?.scrollPosition;

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
          currentPage: maxCurrentPage,
          scrollPosition: latestScroll ?? Prisma.JsonNull,
          lastOpenedAt: latestOpenedAt || null,
          lastReadAt: latestReadAt || null,
        },
        update: {
          rating: maxRating,
          readStatus,
          currentPage: maxCurrentPage,
          scrollPosition: latestScroll ?? undefined,
          lastOpenedAt: latestOpenedAt || undefined,
          lastReadAt: latestReadAt || undefined,
        },
      });
    }

    await tx.state.deleteMany({
      where: { itemId: { in: sourceItemIds } },
    });
  }
}
