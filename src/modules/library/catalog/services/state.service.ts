import {
  Injectable,
  Inject,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StateRepository } from '@/modules/library/catalog/repositories/saved-searches.repository';
import { UpdateStateDto } from '@/modules/library/catalog/dto/collections.dto';
import {
  StateData,
  ReadingStatus,
  StateEntity,
  UpsertStateData,
} from '@/modules/library/catalog/types/catalog.types';
import {
  TransactionHelpers,
  UNIT_OF_WORK,
  IUnitOfWork,
  LIBRARY_EVENT_TYPES,
  normalizeProjectScopeId,
} from '@/modules/library/core';
import { ItemQueryService } from './item-query.service';
import {
  toStateResponse,
  isValidRating,
  isValidCurrentPage,
  shouldAutoAdvanceToReading,
  isValidStateTransition,
  isValidScrollPosition,
  mergeScrollPosition,
  pickPreferredMergedState,
} from '@/modules/library/catalog/domain/state.domain';
import { RedisCacheService } from '@/core';
import { AccessService, Permission } from '@/modules/project/access';
import { ItemCacheCoordinator } from './schema-validator.service';
import { ReaderWriteBehindService } from './reader-write-behind.service';

export { pickPreferredMergedState };

@Injectable()
export class StateService {
  private readonly cacheCoordinator: ItemCacheCoordinator;

  constructor(
    private readonly stateRepository: StateRepository,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx: IUnitOfWork,
    @Optional()
    private readonly itemExistencePort?: ItemQueryService,
    @Optional()
    @Inject(RedisCacheService)
    private readonly cache?: RedisCacheService,
    @Optional()
    @Inject(ItemCacheCoordinator)
    cacheCoordinator?: ItemCacheCoordinator,
    @Optional()
    @Inject(ReaderWriteBehindService)
    private readonly writeBehind?: ReaderWriteBehindService,
    @Optional()
    private readonly accessService?: AccessService & {
      verifyProjectAccess?: (
        userId: string,
        projectId: string,
      ) => Promise<unknown>;
    },
  ) {
    this.cacheCoordinator =
      cacheCoordinator ?? new ItemCacheCoordinator(this.cache);
  }

  private async invalidateStateCache(
    itemId: string,
    userId: string,
    projectId?: string,
    options?: {
      skipScopeInvalidation?: boolean;
      onlyUserStateOverlay?: boolean;
      preserveContentCaches?: boolean;
    },
  ): Promise<void> {
    await this.cacheCoordinator.invalidateItemCache(
      itemId,
      userId,
      projectId,
      options,
    );
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

    let state = await this.stateRepository.findState(userId, itemId);

    if (this.writeBehind) {
      const buffered = await this.writeBehind.getBufferedProgress(userId, itemId);
      if (buffered) {
        state = {
          userId,
          itemId,
          readStatus: state?.readStatus ?? ReadingStatus.UNREAD,
          isStarred: state?.isStarred ?? false,
          rating: state?.rating ?? null,
          currentPage: buffered.currentPage ?? state?.currentPage ?? 1,
          scrollPosition: buffered.scrollPosition ?? state?.scrollPosition ?? null,
          lastActiveAttachmentId: buffered.attachmentId ?? state?.lastActiveAttachmentId ?? null,
          lastOpenedAt: buffered.lastOpenedAt ? new Date(buffered.lastOpenedAt) : (state?.lastOpenedAt ?? new Date()),
          lastReadAt: buffered.lastReadAt ? new Date(buffered.lastReadAt) : (state?.lastReadAt ?? null),
          createdAt: state?.createdAt ?? new Date(),
          updatedAt: new Date(),
        };
      }
    }

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

    // Write-Behind Fast Path: High-frequency reading progress (page scrolling, offset, zoom)
    // Coalesces rapid heartbeats into Redis buffer, bypassing heavy DB transactions and locks.
    const isPureProgressPayload =
      dto.isStarred === undefined &&
      dto.rating === undefined &&
      dto.readStatus === undefined;

    if (isPureProgressPayload && this.writeBehind) {
      const existing = await this.stateRepository.findState(userId, itemId);
      const currentStatus =
        (existing?.readStatus as ReadingStatus) ?? ReadingStatus.UNREAD;
      const shouldAdvance = shouldAutoAdvanceToReading(
        currentStatus,
        dto.currentPage,
        dto.scrollPosition,
      );

      // If status transition from UNREAD to READING is not triggered (or already reading), fast-path buffer
      if (!shouldAdvance || currentStatus === ReadingStatus.READING) {
        const now = new Date();
        const resolvedAttachmentId =
          dto.attachmentId?.trim() ||
          (dto.scrollPosition &&
          typeof dto.scrollPosition === 'object' &&
          !Array.isArray(dto.scrollPosition) &&
          typeof (dto.scrollPosition as Record<string, unknown>).attachmentId ===
            'string'
            ? (
                (dto.scrollPosition as Record<string, unknown>)
                  .attachmentId as string
              ).trim()
            : undefined);

        const mergedScrollPosition =
          dto.scrollPosition !== undefined
            ? mergeScrollPosition(
                existing?.scrollPosition,
                dto.scrollPosition,
                resolvedAttachmentId,
              )
            : undefined;

        await this.writeBehind.bufferProgress(userId, itemId, {
          currentPage: dto.currentPage,
          scrollPosition: mergedScrollPosition,
          attachmentId: resolvedAttachmentId,
          lastOpenedAt: now,
          lastReadAt: now,
        });

        const optimisticEntity: StateEntity = {
          userId,
          itemId,
          readStatus: currentStatus,
          isStarred: existing?.isStarred ?? false,
          rating: existing?.rating ?? null,
          currentPage: dto.currentPage ?? existing?.currentPage ?? 1,
          scrollPosition: mergedScrollPosition ?? existing?.scrollPosition ?? null,
          lastActiveAttachmentId: resolvedAttachmentId ?? existing?.lastActiveAttachmentId ?? null,
          lastOpenedAt: now,
          lastReadAt: now,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        return this.toResponse(optimisticEntity);
      }
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

      const resolvedAttachmentId =
        dto.attachmentId?.trim() ||
        (dto.scrollPosition &&
        typeof dto.scrollPosition === 'object' &&
        !Array.isArray(dto.scrollPosition) &&
        typeof (dto.scrollPosition as Record<string, unknown>).attachmentId ===
          'string'
          ? (
              (dto.scrollPosition as Record<string, unknown>)
                .attachmentId as string
            ).trim()
          : undefined);

      const mergedScrollPosition =
        dto.scrollPosition !== undefined
          ? mergeScrollPosition(
              existing?.scrollPosition,
              dto.scrollPosition,
              resolvedAttachmentId,
            )
          : undefined;

      if (
        mergedScrollPosition !== undefined &&
        !isValidScrollPosition(mergedScrollPosition)
      ) {
        throw new BadRequestException(
          'scrollPosition payload exceeds maximum allowed size of 16KB or is invalid',
        );
      }

      const upsertData: UpsertStateData = {
        ...(resolvedAttachmentId ? { attachmentId: resolvedAttachmentId } : {}),
        isStarred:
          dto.isStarred !== undefined ? dto.isStarred : existing?.isStarred,
        readStatus: targetStatus,
        rating:
          dto.rating !== undefined
            ? dto.rating
            : (existing?.rating ?? undefined),
        currentPage: dto.currentPage,
        scrollPosition: mergedScrollPosition,
        lastOpenedAt: now,
        lastReadAt: isNowReadingOrCompleted
          ? now
          : (existing?.lastReadAt ?? undefined),
      };

      const isEphemeralProgressOnly =
        dto.isStarred === undefined &&
        dto.rating === undefined &&
        dto.readStatus === undefined &&
        targetStatus === currentStatus;

      const updated = await this.stateRepository.upsertState(
        userId,
        itemId,
        upsertData,
        tx,
      );

      if (!isEphemeralProgressOnly) {
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
      }

      helpers?.onAfterCommit?.(() =>
        this.invalidateStateCache(itemId, userId, effectiveProjectId, {
          skipScopeInvalidation: isEphemeralProgressOnly,
          onlyUserStateOverlay: isEphemeralProgressOnly,
          preserveContentCaches: true,
        }),
      );

      return {
        response: this.toResponse(updated),
        isEphemeralProgressOnly,
      };
    };

    let ranPostCommitHook = false;
    const { response, isEphemeralProgressOnly } =
      await this.libraryTx.executeInTransaction(async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers?.onAfterCommit);
        return execute(tx, helpers);
      });
    if (!ranPostCommitHook) {
      await this.invalidateStateCache(itemId, userId, effectiveProjectId, {
        skipScopeInvalidation: isEphemeralProgressOnly,
        onlyUserStateOverlay: isEphemeralProgressOnly,
        preserveContentCaches: true,
      });
    }
    return response;
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
      const nextStatus = ReadingStatus.COMPLETED;

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

      helpers?.onAfterCommit?.(() =>
        this.invalidateStateCache(itemId, userId, effectiveProjectId),
      );

      return this.toResponse(updated);
    };

    let ranPostCommitHook = false;
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers?.onAfterCommit);
        return execute(tx, helpers);
      },
    );
    if (!ranPostCommitHook) {
      await this.invalidateStateCache(itemId, userId, effectiveProjectId);
    }
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

    const validProjectId = normalizeProjectScopeId(projectId);
    if (validProjectId && this.accessService) {
      if (typeof this.accessService.verifyProjectAccess === 'function') {
        await this.accessService.verifyProjectAccess(userId, validProjectId);
      } else if (typeof this.accessService.requirePermission === 'function') {
        await this.accessService.requirePermission(
          validProjectId,
          userId,
          Permission.LIBRARY_READ,
        );
      }
    }

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
