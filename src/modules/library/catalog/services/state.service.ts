import {
  Injectable,
  Inject,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StateRepository } from '@/modules/library/catalog/repositories/state.repository';
import { UpdateStateDto } from '@/modules/library/catalog/dto/tags.dto';
import {
  StateData,
  ReadingStatus,
  StateEntity,
  UpsertStateData,
} from '@/modules/library/catalog/types/catalog.types';
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
  pickPreferredMergedState,
} from '@/modules/library/catalog/domain/state.domain';
import { RedisCacheService } from '@/core';
import { ItemCacheCoordinator } from './item-cache.coordinator';

export { pickPreferredMergedState };

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
    private readonly cache?: RedisCacheService,
    @Optional()
    @Inject(ItemCacheCoordinator)
    cacheCoordinator?: ItemCacheCoordinator,
  ) {
    this.cacheCoordinator =
      cacheCoordinator ?? new ItemCacheCoordinator(this.cache);
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
      const existing = await this.stateRepository.findState(userId, itemId, tx);

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
          dto.rating !== undefined
            ? dto.rating
            : (existing?.rating ?? undefined),
        currentPage: dto.currentPage,
        scrollPosition: dto.scrollPosition,
        lastOpenedAt: now,
        lastReadAt: isNowReadingOrCompleted
          ? (existing?.lastReadAt ?? now)
          : undefined,
      };

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
    const effectiveProjectId = projectId || item.projectId || undefined;
    const eventScope = { userId, projectId: effectiveProjectId };

    const execute = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => {
      const existing = await this.stateRepository.findState(userId, itemId, tx);

      const nextStatus =
        existing?.readStatus === ReadingStatus.COMPLETED
          ? ReadingStatus.COMPLETED
          : ReadingStatus.READING;

      const now = new Date();
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
    projectId?: string,
  ): Promise<Record<string, StateData>> {
    if (!itemIds.length) return {};

    const states = await this.stateRepository.findStatesForItems(
      userId,
      itemIds,
      undefined,
      projectId,
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

    await this.stateRepository.transferItemStates(
      cleanSourceIds,
      targetItemId,
      tx,
    );
  }
}
