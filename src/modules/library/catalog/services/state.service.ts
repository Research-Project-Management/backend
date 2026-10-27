import { Injectable, Inject, BadRequestException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StateRepository } from '@/modules/library/catalog/repositories/state.repository';
import { UpdateStateDto } from '@/modules/library/catalog/dto/state.dto';
import {
  StateData,
  ReadingStatus,
  StateEntity,
  UpsertStateData,
} from '@/modules/library/catalog/types/state.types';
import {
  TransactionHelpers,
  LIBRARY_EVENT_TYPES,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { ItemQueryService } from './item-query.service';
import {
  toStateResponse,
  isValidRating,
  isValidCurrentPage,
  shouldAutoAdvanceToReading,
  isValidStateTransition,
  isValidScrollPosition,
} from '@/modules/library/catalog/domain/state.domain';
import { RedisCacheService } from '@/core';
import { ItemCacheCoordinator } from './item-cache.coordinator';

@Injectable()
export class StateService {
  private readonly cacheCoordinator: ItemCacheCoordinator;

  constructor(
    private readonly stateRepository: StateRepository,
    private readonly libraryTx: TransactionService,
    @Optional()
    private readonly itemExistencePort?: ItemQueryService,
    @Optional()
    @Inject(RedisCacheService)
    cacheOrCoordinator?: RedisCacheService | ItemCacheCoordinator,
    @Optional()
    @Inject(ItemCacheCoordinator)
    injectedCoordinator?: ItemCacheCoordinator,
  ) {
    if (injectedCoordinator) {
      this.cacheCoordinator = injectedCoordinator;
    } else if (cacheOrCoordinator instanceof ItemCacheCoordinator) {
      this.cacheCoordinator = cacheOrCoordinator;
    } else {
      this.cacheCoordinator = new ItemCacheCoordinator(cacheOrCoordinator);
    }
  }

  private async invalidateStateCache(
    itemId: string,
    userId: string,
    projectId?: string,
  ): Promise<void> {
    await this.cacheCoordinator.invalidateItemCache(itemId, userId, projectId);
  }

  private toResponse(state?: StateEntity | null): StateData {
    return toStateResponse(state);
  }

  async getState(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<StateData> {
    await this.assertItemExists(userId, itemId, projectId);

    const state = await this.stateRepository.findState(userId, itemId);

    return this.toResponse(state);
  }

  async updateState(
    userId: string,
    itemId: string,
    dto: UpdateStateDto,
    projectId?: string,
  ): Promise<StateData> {
    const item = await this.assertItemExists(userId, itemId, projectId);

    if (dto.rating !== undefined && !isValidRating(dto.rating)) {
      throw new BadRequestException(
        'rating must be an integer between 0 and 5',
      );
    }
    if (dto.currentPage !== undefined && !isValidCurrentPage(dto.currentPage)) {
      throw new BadRequestException('currentPage must be an integer >= 1');
    }
    if (
      dto.scrollPosition !== undefined &&
      !isValidScrollPosition(dto.scrollPosition)
    ) {
      throw new BadRequestException(
        'scrollPosition payload exceeds maximum allowed size of 16KB or is invalid',
      );
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
      isStarred:
        dto.isStarred !== undefined ? dto.isStarred : existing?.isStarred,
      readStatus: targetStatus,
      rating:
        dto.rating !== undefined ? dto.rating : (existing?.rating ?? undefined),
      currentPage: dto.currentPage,
      scrollPosition: dto.scrollPosition,
      lastOpenedAt: now,
      lastReadAt: isNowReadingOrCompleted
        ? (existing?.lastReadAt ?? now)
        : undefined,
    };

    const effectiveProjectId =
      projectId ||
      ('projectId' in item && typeof item.projectId === 'string'
        ? item.projectId
        : undefined);
    const eventScope = { userId, projectId: effectiveProjectId };

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

      await helpers.appendChange(eventScope, {
        entityType: 'State',
        entityId: `${userId}:${itemId}`,
        action: 'update',
        version: 1,
        data: updated,
      });

      await helpers.publishOutbox(
        eventScope,
        itemId,
        LIBRARY_EVENT_TYPES.READING_STATE_UPDATED,
        {
          itemId,
          userId,
          projectId: effectiveProjectId,
          isStarred: updated.isStarred,
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

    const result = await this.libraryTx.executeInTransaction(execute);
    await this.invalidateStateCache(itemId, userId, effectiveProjectId);
    return result;
  }

  async markAsRead(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<StateData> {
    const item = await this.assertItemExists(userId, itemId, projectId);
    const existing = await this.stateRepository.findState(userId, itemId);

    const nextStatus =
      existing?.readStatus === ReadingStatus.COMPLETED
        ? ReadingStatus.COMPLETED
        : ReadingStatus.READING;

    const now = new Date();
    const effectiveProjectId = projectId || item.projectId || undefined;
    const eventScope = { userId, projectId: effectiveProjectId };

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

      await helpers.appendChange(eventScope, {
        entityType: 'State',
        entityId: `${userId}:${itemId}`,
        action: 'update',
        version: 1,
        data: updated,
      });

      await helpers.publishOutbox(
        eventScope,
        itemId,
        LIBRARY_EVENT_TYPES.READING_STATE_UPDATED,
        {
          itemId,
          userId,
          projectId: effectiveProjectId,
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

    const result = await this.libraryTx.executeInTransaction(execute);
    await this.invalidateStateCache(itemId, userId, effectiveProjectId);
    return result;
  }

  private async assertItemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<{ id: string; userId: string; projectId: string | null }> {
    if (this.itemExistencePort) {
      await this.itemExistencePort.assertExists(userId, itemId, projectId);
    }
    return { id: itemId, userId, projectId: projectId ?? null };
  }

  async getBatchStates(
    userId: string,
    itemIds: string[],
    _projectId?: string,
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
    const cleanSourceIds = sourceItemIds.filter((id) => id !== targetItemId);
    if (cleanSourceIds.length === 0) return;

    const allUserStates = await tx.state.findMany({
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
        const maxRating = Math.max(...states.map((s) => s.rating || 0));
        const isStarred = states.some((s) => Boolean(s.isStarred));
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
        const statesWithScroll = states.filter((s) => s.scrollPosition !== null);
        statesWithScroll.sort((a, b) => {
          const readA = a.lastReadAt ? a.lastReadAt.getTime() : 0;
          const readB = b.lastReadAt ? b.lastReadAt.getTime() : 0;
          if (readB !== readA) return readB - readA;

          const openA = a.lastOpenedAt ? a.lastOpenedAt.getTime() : 0;
          const openB = b.lastOpenedAt ? b.lastOpenedAt.getTime() : 0;
          if (openB !== openA) return openB - openA;

          return (b.currentPage || 1) - (a.currentPage || 1);
        });
        const latestScroll = statesWithScroll[0]?.scrollPosition;

        return tx.state.upsert({
          where: {
            userId_itemId: {
              userId,
              itemId: targetItemId,
            },
          },
          create: {
            userId,
            itemId: targetItemId,
            isStarred,
            rating: maxRating,
            readStatus,
            currentPage: maxCurrentPage,
            scrollPosition: latestScroll ?? Prisma.JsonNull,
            lastOpenedAt: latestOpenedAt || null,
            lastReadAt: latestReadAt || null,
          },
          update: {
            isStarred,
            rating: maxRating,
            readStatus,
            currentPage: maxCurrentPage,
            scrollPosition: latestScroll ?? undefined,
            lastOpenedAt: latestOpenedAt || undefined,
            lastReadAt: latestReadAt || undefined,
          },
        });
      }),
    );

    await tx.state.deleteMany({
      where: { itemId: { in: cleanSourceIds } },
    });
  }
}
