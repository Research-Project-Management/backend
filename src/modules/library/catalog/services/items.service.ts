import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import {
  CreateItemData,
  UpdateItemData,
  ItemDetail,
  ItemTransactionContext,
} from '@/modules/library/core/types/bibliographic.types';
import {
  sanitizeItemTitle,
  normalizeProjectScopeId,
  TransactionHelpers,
  UNIT_OF_WORK,
  IUnitOfWork,
  LIBRARY_EVENT_TYPES,
  buildItemCreatedOutboxPayload,
  LibraryItemSource,
} from '@/modules/library/core';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { TagsService } from './tags.service';
import { ItemCacheCoordinator } from './item-cache.coordinator';
import { ZoteroSchemaValidatorService } from './zotero-schema-validator.service';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import {
  executeBulkSoftDeleteInTx,
  executeBulkRestoreInTx,
  executeBulkPurgeInTx,
  executePurgeExpiredTrashInTx,
} from './item-curation.service';
export type { ItemTransactionContext };
@Injectable()
export class ItemService {
  private readonly logger = new Logger(ItemService.name);
  private readonly cacheCoordinator: ItemCacheCoordinator;
  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx: IUnitOfWork,
    private readonly tagsService: TagsService,
    @Optional()
    private readonly validator?: ZoteroSchemaValidatorService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() cacheCoordinator?: ItemCacheCoordinator,
  ) {
    this.cacheCoordinator =
      cacheCoordinator ?? new ItemCacheCoordinator(cache);
  }
  async invalidateItemCache(
    id: string,
    userId?: string,
    projectId?: string,
    options?: { skipScopeInvalidation?: boolean },
  ): Promise<void> {
    return this.cacheCoordinator.invalidateItemCache(
      id,
      userId,
      projectId,
      options,
    );
  }
  async invalidateScopeListCache(
    userId: string,
    projectId?: string,
  ): Promise<void> {
    return this.cacheCoordinator.invalidateScopeListCache(userId, projectId);
  }
  async getItem(userId: string, id: string, projectId?: string) {
    const item = await this.query.findById(userId, id, projectId);
    return item
      ? (ItemsMapper.mapFlattenedState(item, userId) ??
          ItemsMapper.toDomain(item))
      : null;
  }
  async createItem(
    userId: string,
    data: CreateItemData,
    context?: Partial<ItemTransactionContext> & {
      projectId?: string;
      source?: LibraryItemSource;
      idempotencyKey?: string;
      correlationId?: string;
    },
    projectId?: string,
  ): Promise<ItemDetail> {
    const dataRec = data as Record<string, unknown>;
    const dataEf =
      data.extraFields && typeof data.extraFields === 'object'
        ? data.extraFields
        : {};
    const fallbackTitle =
      data.title ??
      (dataRec.caseName as string | undefined) ??
      (dataRec.nameOfAct as string | undefined) ??
      (dataRec.subject as string | undefined) ??
      (dataEf.caseName as string | undefined) ??
      (dataEf.nameOfAct as string | undefined) ??
      (dataEf.subject as string | undefined);
    const cleanTitle = sanitizeItemTitle(fallbackTitle);
    if (!cleanTitle) {
      throw new UnprocessableEntityException('Item title cannot be empty');
    }
    data.title = cleanTitle;
    const valRes = this.validator?.validateAndSanitizeItem
      ? this.validator.validateAndSanitizeItem(data.itemType, data)
      : { sanitizedItem: data, warnings: [] };
    const itemPayload = valRes.sanitizedItem as CreateItemData;
    const effectiveProjectId = normalizeProjectScopeId(
      projectId || context?.projectId || itemPayload.projectId,
    );
    const execute = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => {
      const item = await this.command.create(
        userId,
        itemPayload,
        tx,
        effectiveProjectId,
      );
      const domainCreated = (ItemsMapper.mapFlattenedState(item, userId) ??
        ItemsMapper.toDomain(item)) as ItemDetail;
      await helpers.appendChange(
        { userId, projectId: effectiveProjectId },
        {
          entityType: 'Item',
          entityId: item.id,
          action: 'create',
          version: item.version,
          data: domainCreated,
        },
      );
      const payload = buildItemCreatedOutboxPayload({
        itemId: item.id,
        userId,
        projectId: effectiveProjectId,
        title: item.title,
        source: context?.source ?? 'manual',
        doi: item.doi,
      });
      await helpers.publishOutbox(
        { userId, projectId: effectiveProjectId },
        item.id,
        LIBRARY_EVENT_TYPES.ITEM_CREATED,
        payload,
      );
      helpers.onAfterCommit?.(() =>
        this.invalidateScopeListCache(userId, effectiveProjectId),
      );
      return domainCreated;
    };
    let result: ItemDetail;
    let ranPostCommitHook = false;
    if (context?.tx && context?.helpers) {
      result = await execute(context.tx, context.helpers);
    } else {
      result = await this.libraryTx.executeInTransaction(
        async (tx, helpers) => {
          ranPostCommitHook = Boolean(helpers.onAfterCommit);
          return execute(tx, helpers);
        },
      );
    }
    if (!ranPostCommitHook) {
      await this.invalidateScopeListCache(userId, effectiveProjectId);
    }
    return result;
  }
  async updateItem(
    userId: string,
    id: string,
    expectedVersion: number | undefined,
    data: UpdateItemData,
    context?: ItemTransactionContext,
    projectId?: string,
  ): Promise<ItemDetail> {
    if (data.title !== undefined) {
      const cleanTitle = sanitizeItemTitle(data.title);
      if (!cleanTitle) {
        throw new UnprocessableEntityException('Item title cannot be empty');
      }
      data.title = cleanTitle;
    }
    let resolvedProjectId = normalizeProjectScopeId(projectId);
    const effectiveExpectedVersion =
      expectedVersion ??
      (typeof (data as { expectedVersion?: unknown }).expectedVersion ===
      'number'
        ? (data as { expectedVersion: number }).expectedVersion
        : undefined);
    let ranPostCommitHook = false;
    const executeUpdate = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ): Promise<ItemDetail> => {
      let targetItemType = data.itemType;
      if (!targetItemType && this.validator?.validateAndSanitizeItem) {
        const existing = this.query.findSummaryById
          ? await this.query.findSummaryById(userId, id, tx, projectId)
          : await this.query.findById(userId, id, projectId, tx, false, false);
        if (existing) {
          targetItemType =
            existing.itemType ||
            (existing as { type?: string }).type ||
            'journalArticle';
        }
      }
      let updatePayload = data;
      if (targetItemType) {
        const valRes = this.validator?.validateAndSanitizeItem
          ? this.validator.validateAndSanitizeItem(targetItemType, data)
          : { sanitizedItem: data, warnings: [] };
        updatePayload = valRes.sanitizedItem;
      }
      const updated = await this.command.update(
        userId,
        id,
        effectiveExpectedVersion,
        updatePayload,
        tx,
        resolvedProjectId,
      );
      const effectiveProjectId =
        resolvedProjectId || updated.projectId || undefined;
      resolvedProjectId = effectiveProjectId;
      const eventScope = { userId, projectId: effectiveProjectId };
      const domainUpdated = (ItemsMapper.mapFlattenedState(updated, userId) ??
        ItemsMapper.toDomain(updated)) as ItemDetail;
      const updatedFields = Object.keys(data);
      await helpers.appendChange(eventScope, {
        entityType: 'Item',
        entityId: id,
        action: 'update',
        version: updated.version,
        data: domainUpdated,
      });
      await helpers.publishOutbox(
        eventScope,
        id,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        {
          ...(domainUpdated as unknown as Record<string, unknown>),
          updatedFields,
        },
      );
      helpers.onAfterCommit?.(() =>
        this.invalidateItemCache(id, userId, resolvedProjectId),
      );
      return domainUpdated;
    };
    const res = context
      ? await executeUpdate(context.tx, context.helpers)
      : await this.libraryTx.executeInTransaction(async (tx, helpers) => {
          ranPostCommitHook = Boolean(helpers.onAfterCommit);
          return executeUpdate(tx, helpers);
        });
    if (!ranPostCommitHook) {
      await this.invalidateItemCache(id, userId, resolvedProjectId);
    }
    return res;
  }
  async setMyPublication(
    userId: string,
    id: string,
    isMyPublication: boolean,
    options?: {
      contributorId?: string | null;
      isPublic?: boolean;
      openAccessLicense?: string | null;
      includeAttachments?: boolean;
      includeNotes?: boolean;
      authorshipConfirmed?: boolean;
      projectId?: string;
    },
  ): Promise<ItemDetail> {
    let resolvedProjectId: string | undefined;
    let ranPostCommitHook = false;
    const res = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers.onAfterCommit);
        const updated = await this.command.setMyPublication(
          userId,
          id,
          isMyPublication,
          options,
          tx,
        );
        const effectiveProjectId = updated.projectId || undefined;
        resolvedProjectId = effectiveProjectId;
        const eventScope = { userId, projectId: effectiveProjectId };
        const domainItem = (ItemsMapper.mapFlattenedState(updated, userId) ??
          ItemsMapper.toDomain(updated)) as ItemDetail;
        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: id,
          action: 'update',
          version: updated.version,
          data: domainItem,
        });
        await helpers.publishOutbox(
          eventScope,
          id,
          LIBRARY_EVENT_TYPES.ITEM_UPDATED,
          domainItem,
        );
        helpers.onAfterCommit?.(() =>
          this.invalidateItemCache(id, userId, resolvedProjectId),
        );
        return domainItem;
      },
    );
    if (!ranPostCommitHook) {
      await this.invalidateItemCache(id, userId, resolvedProjectId);
    }
    return res;
  }
  async reindexItem(userId: string, id: string, projectId?: string) {
    const item = await this.query.findById(userId, id, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in user library`);
    }
    const effectiveProjectId =
      normalizeProjectScopeId(projectId) ?? item.projectId ?? undefined;
    const eventScope = { userId, projectId: effectiveProjectId };
    await this.libraryTx.executeInTransaction(async (_tx, helpers) => {
      await helpers.publishOutbox(
        eventScope,
        id,
        LIBRARY_EVENT_TYPES.ITEM_REINDEXED,
        {
          itemId: id,
          userId,
          projectId: effectiveProjectId,
        },
      );
    });
    return {
      success: true,
      message: 'Item re-indexing requested',
      itemId: id,
    };
  }
  async deleteItem(
    userId: string,
    id: string,
    expectedVersion?: number,
    context?: ItemTransactionContext,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ): Promise<boolean> {
    const validProjectId = normalizeProjectScopeId(projectId);
    const executeDelete = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ): Promise<boolean> => {
      const deleted = await this.command.softDelete(
        userId,
        id,
        expectedVersion,
        tx,
        validProjectId,
      );
      if (deleted) {
        const eventScope = { userId, projectId: validProjectId };
        const deletedAt = new Date();
        await helpers.recordTombstone(eventScope, {
          entityType: 'Item',
          entityId: id,
        });
        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: id,
          action: 'delete',
          version: 0,
          data: { id, deletedAt: deletedAt.toISOString() },
        });
        await helpers.publishOutbox(
          eventScope,
          id,
          LIBRARY_EVENT_TYPES.ITEM_DELETED,
          { id, deletedAt, projectId: validProjectId },
        );
        helpers.onAfterCommit?.(() =>
          this.invalidateItemCache(id, userId, validProjectId, {
            skipScopeInvalidation,
          }),
        );
      }
      return deleted;
    };
    let ranPostCommitHook = false;
    const deleted = context
      ? await executeDelete(context.tx, context.helpers)
      : await this.libraryTx.executeInTransaction(async (tx, helpers) => {
          ranPostCommitHook = Boolean(helpers.onAfterCommit);
          return executeDelete(tx, helpers);
        });
    if (deleted && !ranPostCommitHook) {
      await this.invalidateItemCache(id, userId, validProjectId, {
        skipScopeInvalidation,
      });
    }
    return deleted;
  }
  async restoreItem(
    userId: string,
    id: string,
    expectedVersion?: number,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ) {
    const validProjectId = normalizeProjectScopeId(projectId);
    let ranPostCommitHook = false;
    const res = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers.onAfterCommit);
        const restored = await this.command.restore(
          userId,
          id,
          expectedVersion,
          tx,
          validProjectId,
        );
        const effectiveProjectId =
          validProjectId || restored.projectId || undefined;
        const eventScope = { userId, projectId: effectiveProjectId };
        const domainItem = (ItemsMapper.mapFlattenedState(restored, userId) ??
          ItemsMapper.toDomain(restored)) as ItemDetail;
        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: id,
          action: 'update',
          version: restored.version,
          data: domainItem,
        });
        await helpers.removeTombstone(eventScope, 'Item', id);
        await helpers.publishOutbox(
          eventScope,
          id,
          LIBRARY_EVENT_TYPES.ITEM_RESTORED,
          {
            itemId: id,
            userId,
            projectId: effectiveProjectId,
            restoredAt: new Date().toISOString(),
          },
        );
        helpers.onAfterCommit?.(() =>
          this.invalidateItemCache(id, userId, validProjectId, {
            skipScopeInvalidation,
          }),
        );
        return domainItem;
      },
    );
    if (!ranPostCommitHook) {
      await this.invalidateItemCache(id, userId, validProjectId, {
        skipScopeInvalidation,
      });
    }
    return res;
  }
  async purgeItem(
    userId: string,
    id: string,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ): Promise<boolean> {
    const validProjectId = normalizeProjectScopeId(projectId);
    let storagePathsToDelete: string[] = [];
    let ranPostCommitHook = false;
    const purged = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers.onAfterCommit);
        const purgeRes = this.command.purgeWithStoragePaths
          ? await this.command.purgeWithStoragePaths(
              userId,
              id,
              tx,
              validProjectId,
              { skipStorageDelete: true },
            )
          : {
              purged: await this.command.purge(userId, id, tx, validProjectId),
              storagePaths: [] as string[],
            };
        if (purgeRes.purged) {
          storagePathsToDelete = purgeRes.storagePaths;
          const eventScope = { userId, projectId: validProjectId };
          await helpers.recordTombstone(eventScope, {
            entityType: 'Item',
            entityId: id,
          });
          await helpers.appendChange(eventScope, {
            entityType: 'Item',
            entityId: id,
            action: 'delete',
            version: 0,
          });
          await helpers.publishOutbox(
            eventScope,
            id,
            LIBRARY_EVENT_TYPES.ITEM_PURGED,
            {
              itemId: id,
              itemIds: [id],
              userId,
              projectId: validProjectId,
              filePaths: purgeRes.storagePaths,
              purgedAt: new Date().toISOString(),
            },
          );
          helpers.onAfterCommit?.(() =>
            this.invalidateItemCache(id, userId, validProjectId, {
              skipScopeInvalidation,
            }),
          );
        }
        return purgeRes.purged;
      },
    );
    if (purged && !ranPostCommitHook) {
      await this.invalidateItemCache(id, userId, validProjectId, {
        skipScopeInvalidation,
      });
    }
    if (storagePathsToDelete.length > 0) {
      await this.command.deleteStorageFilesBatch(storagePathsToDelete);
    }
    return purged;
  }
  private async invalidateBulkItemsCache(
    itemIds: string[],
    userId: string,
    projectId?: string,
    additionalProjectIds?: Array<string | null | undefined>,
  ): Promise<void> {
    return this.cacheCoordinator.invalidateBulkItemsCache(
      itemIds,
      userId,
      projectId,
      additionalProjectIds,
    );
  }
  async bulkTrash(userId: string, itemIds: string[], projectId?: string) {
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return {
        success: true,
        trashedCount: 0,
        succeededIds: [] as string[],
        failedIds: [] as string[],
      };
    }
    const validProjectId = normalizeProjectScopeId(projectId);
    let ranPostCommitHook = false;
    const { succeededIds, failedIds } =
      await this.libraryTx.executeInTransaction(async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers.onAfterCommit);
        const res = await executeBulkSoftDeleteInTx({
          command: this.command,
          userId,
          itemIds,
          tx,
          helpers,
          validProjectId,
        });
        if (res.succeededIds.length > 0) {
          helpers.onAfterCommit?.(() =>
            this.invalidateBulkItemsCache(res.succeededIds, userId, validProjectId),
          );
        }
        return res;
      });
    if (succeededIds.length > 0 && !ranPostCommitHook) {
      await this.invalidateBulkItemsCache(succeededIds, userId, validProjectId);
    }
    return {
      success: true,
      trashedCount: succeededIds.length,
      succeededIds,
      failedIds,
    };
  }
  async bulkRestore(userId: string, itemIds: string[], projectId?: string) {
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return {
        success: true,
        restoredCount: 0,
        succeededIds: [] as string[],
        failedIds: [] as string[],
      };
    }
    const validProjectId = normalizeProjectScopeId(projectId);
    let ranPostCommitHook = false;
    const { succeededIds, failedIds, restoredItems } =
      await this.libraryTx.executeInTransaction(async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers.onAfterCommit);
        const res = await executeBulkRestoreInTx({
          command: this.command,
          query: this.query,
          userId,
          itemIds,
          tx,
          helpers,
          validProjectId,
        });
        if (res.succeededIds.length > 0) {
          helpers.onAfterCommit?.(() =>
            this.invalidateBulkItemsCache(
              res.succeededIds,
              userId,
              validProjectId,
              res.restoredItems.map((r) => r.projectId),
            ),
          );
        }
        return res;
      });
    if (succeededIds.length > 0 && !ranPostCommitHook) {
      await this.invalidateBulkItemsCache(
        succeededIds,
        userId,
        validProjectId,
        restoredItems.map((r) => r.projectId),
      );
    }
    return {
      success: true,
      restoredCount: succeededIds.length,
      succeededIds,
      failedIds,
    };
  }
  async bulkPurge(userId: string, itemIds: string[], projectId?: string) {
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return {
        success: true,
        purgedCount: 0,
        succeededIds: [] as string[],
        failedIds: [] as string[],
      };
    }
    const validProjectId = normalizeProjectScopeId(projectId);
    let ranPostCommitHook = false;
    const { succeededIds, failedIds, fileIdsToDelete } =
      await this.libraryTx.executeInTransaction(async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers.onAfterCommit);
        const res = await executeBulkPurgeInTx({
          command: this.command,
          userId,
          itemIds,
          tx,
          helpers,
          validProjectId,
        });
        if (res.succeededIds.length > 0) {
          helpers.onAfterCommit?.(() =>
            this.invalidateBulkItemsCache(res.succeededIds, userId, validProjectId),
          );
        }
        return res;
      });
    if (succeededIds.length > 0 && !ranPostCommitHook) {
      await this.invalidateBulkItemsCache(succeededIds, userId, validProjectId);
    }
    if (fileIdsToDelete.length > 0) {
      await this.command.deleteStorageFilesBatch(fileIdsToDelete);
    }
    return {
      success: true,
      purgedCount: succeededIds.length,
      succeededIds,
      failedIds,
    };
  }
  async purgeExpiredTrash(retentionDays: number = 30, limit: number = 200) {
    let storagePathsToDelete: string[] = [];
    let purgedItemsList: Array<{
      id: string;
      userId: string;
      projectId: string | null;
    }> = [];
    const invalidatePurgedItems = async () => {
      if (purgedItemsList.length === 0) return;
      const itemsByUser = new Map<
        string,
        { itemIds: string[]; projectIds: Array<string | null> }
      >();
      for (const it of purgedItemsList) {
        const entry = itemsByUser.get(it.userId) ?? {
          itemIds: [],
          projectIds: [],
        };
        entry.itemIds.push(it.id);
        entry.projectIds.push(it.projectId);
        itemsByUser.set(it.userId, entry);
      }
      await Promise.all(
        Array.from(itemsByUser.entries()).map(
          ([uid, { itemIds: ids, projectIds }]) =>
            this.invalidateBulkItemsCache(ids, uid, undefined, projectIds),
        ),
      );
    };
    let ranPostCommitHook = false;
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers.onAfterCommit);
        const res = await executePurgeExpiredTrashInTx({
          command: this.command,
          retentionDays,
          limit,
          tx,
          helpers,
        });
        storagePathsToDelete = res.storagePaths;
        purgedItemsList = res.expiredItems ?? [];
        if (purgedItemsList.length > 0) {
          helpers.onAfterCommit?.(invalidatePurgedItems);
        }
        return res;
      },
    );
    if (!ranPostCommitHook) {
      await invalidatePurgedItems();
    }
    if (storagePathsToDelete.length > 0) {
      await this.command.deleteStorageFilesBatch(storagePathsToDelete);
    }
    return result;
  }
}
