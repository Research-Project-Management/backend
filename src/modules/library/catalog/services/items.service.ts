import {
  Injectable, Inject, Logger, NotFoundException, UnprocessableEntityException, Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import {
  CreateItemData, UpdateItemData, ItemDetail, ItemTransactionContext,
} from '@/modules/library/core/types/bibliographic.types';
import {
  sanitizeItemTitle, normalizeProjectScopeId, TransactionHelpers, executeWithPostCommit, UNIT_OF_WORK,
  IUnitOfWork, LIBRARY_EVENT_TYPES, buildItemCreatedOutboxPayload, LibraryItemSource, ItemsMapper,
  SEARCH_FACADE, ISearchFacade,
} from '@/modules/library/core';
import { RedisCacheService } from '@/core';
import { SchemaValidatorService, ItemCacheCoordinator } from './schema-validator.service';
import { executeBulkSoftDeleteInTx, executeBulkRestoreInTx, executeBulkPurgeInTx, executeEmptyTrashInTx, executePurgeExpiredTrashInTx } from '../repositories/command-bulk.operations';
export type { ItemTransactionContext };
@Injectable()
export class ItemService {
  private readonly logger = new Logger(ItemService.name);
  private readonly cacheCoordinator: ItemCacheCoordinator;
  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx: IUnitOfWork,
    @Optional() _tagsService?: unknown,
    @Optional() private readonly validator?: SchemaValidatorService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() cacheCoordinator?: ItemCacheCoordinator,
    @Optional() @Inject(SEARCH_FACADE) private readonly searchGateway?: ISearchFacade,
  ) {
    this.cacheCoordinator = cacheCoordinator ?? new ItemCacheCoordinator(cache);
  }

  private stripPersonalOverlayForSharedScope<T>(item: T, projectId?: string | null): T {
    if (!projectId || !item || typeof item !== 'object') return item;
    const clone = { ...(item as unknown as Record<string, unknown>) };
    for (const k of [
      'isStarred', 'starred', 'isRead', 'readStatus', 'rating', 'currentPage',
      'lastReadPage', 'scrollPosition', 'lastOpenedAt', 'lastReadAt', 'isMyPublication', 'states', 'publications',
    ]) {
      delete clone[k];
    }
    return clone as unknown as T;
  }
  async invalidateItemCache(
    id: string, userId?: string, projectId?: string, options?: { skipScopeInvalidation?: boolean },
  ): Promise<void> {
    return this.cacheCoordinator.invalidateItemCache(id, userId, projectId, options);
  }
  async invalidateScopeListCache(userId: string, projectId?: string): Promise<void> {
    return this.cacheCoordinator.invalidateScopeListCache(userId, projectId);
  }
  async getItem(userId: string, id: string, projectId?: string) {
    const item = await this.query.findById(userId, id, projectId);
    return item ? (ItemsMapper.mapFlattenedState(item, userId) ?? ItemsMapper.toDomain(item)) : null;
  }
  async createItem(
    userId: string,
    data: CreateItemData,
    context?: Partial<ItemTransactionContext> & {
      projectId?: string; source?: LibraryItemSource; idempotencyKey?: string; correlationId?: string;
    },
    projectId?: string,
  ): Promise<ItemDetail> {
    const dataRec = data as Record<string, unknown>;
    const dataEf = data.extraFields && typeof data.extraFields === 'object' ? data.extraFields : {};
    const fallbackTitle =
      data.title ?? (dataRec.caseName as string | undefined) ?? (dataRec.nameOfAct as string | undefined) ??
      (dataRec.subject as string | undefined) ?? (dataEf.caseName as string | undefined) ??
      (dataEf.nameOfAct as string | undefined) ?? (dataEf.subject as string | undefined);
    const cleanTitle = sanitizeItemTitle(fallbackTitle);
    if (!cleanTitle) throw new UnprocessableEntityException('Item title cannot be empty');
    data.title = cleanTitle;
    const isPreNormalized = Boolean((data as { isPreNormalized?: boolean }).isPreNormalized);
    const valRes = this.validator?.validateAndSanitizeItem
      ? this.validator.validateAndSanitizeItem(data.itemType, data)
      : { sanitizedItem: data, warnings: [] };
    const itemPayload = valRes.sanitizedItem as CreateItemData;
    if (isPreNormalized && itemPayload && typeof itemPayload === 'object') {
      Object.defineProperty(itemPayload, 'isPreNormalized', {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
    const effectiveProjectId = normalizeProjectScopeId(projectId || context?.projectId || itemPayload.projectId);
    const execute = async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
      const item = await this.command.create(userId, itemPayload, tx, effectiveProjectId);
      const domainCreated = (ItemsMapper.mapFlattenedState(item, userId) ?? ItemsMapper.toDomain(item)) as ItemDetail;
      const sharedCreatedData = this.stripPersonalOverlayForSharedScope(domainCreated, effectiveProjectId);
      await helpers.appendChange(
        { userId, projectId: effectiveProjectId },
        { entityType: 'Item', entityId: item.id, action: 'create', version: item.version, data: sharedCreatedData },
      );
      const payload = buildItemCreatedOutboxPayload({
        itemId: item.id, userId, projectId: effectiveProjectId, title: item.title,
        source: context?.source ?? 'manual', doi: item.doi,
      });
      await helpers.publishOutbox(
        { userId, projectId: effectiveProjectId }, item.id, LIBRARY_EVENT_TYPES.ITEM_CREATED, payload,
      );
      const createdItemAttachments = Array.isArray((item as { attachments?: unknown[] }).attachments)
        ? ((item as {
            attachments: Array<{
              id?: string; fileId?: string | null; url?: string | null; mimeType?: string | null;
              filename?: string | null; linkMode?: string | null; extractionStatus?: string | null;
            }>;
          }).attachments)
        : [];
      for (const att of createdItemAttachments) {
        if (!att?.id) continue;
        const attRec = att as { size?: number | bigint | null; storageKey?: string | null };
        const isPdf = att.mimeType === 'application/pdf' || Boolean(att.filename && att.filename.toLowerCase().endsWith('.pdf'));
        const hasRealSizeOrKey = Number(attRec.size ?? 0) > 0 || Boolean(attRec.storageKey);
        const hasStoredBinary = att.linkMode !== 'linked_url' && hasRealSizeOrKey && Boolean(att.fileId || (att.url && !att.url.startsWith('http')));
        if (isPdf && hasStoredBinary && (!att.extractionStatus || att.extractionStatus === 'PENDING')) {
          await helpers.publishOutbox(
            { userId, projectId: effectiveProjectId }, att.id, LIBRARY_EVENT_TYPES.ATTACHMENT_EXTRACTION_REQUESTED,
            { attachmentId: att.id, itemId: item.id, userId, projectId: effectiveProjectId },
          );
        }
      }
      return domainCreated;
    };
    if (context?.tx && context?.helpers) {
      if (context.helpers.onAfterCommit) {
        context.helpers.onAfterCommit(() => this.invalidateScopeListCache(userId, effectiveProjectId));
        return execute(context.tx, context.helpers);
      }
      const res = await execute(context.tx, context.helpers);
      await this.invalidateScopeListCache(userId, effectiveProjectId);
      return res;
    }
    if (context?.tx) {
      return execute(context.tx, {} as TransactionHelpers);
    }
    return executeWithPostCommit(
      this.libraryTx,
      (tx, helpers) => execute(tx, helpers),
      () => this.invalidateScopeListCache(userId, effectiveProjectId),
    );
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
      const sharedUpdatedData = this.stripPersonalOverlayForSharedScope(
        domainUpdated,
        effectiveProjectId,
      );
      const updatedFields = Object.keys(data);
      await helpers.appendChange(eventScope, {
        entityType: 'Item',
        entityId: id,
        action: 'update',
        version: updated.version,
        data: sharedUpdatedData,
      });
      await helpers.publishOutbox(
        eventScope,
        id,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        {
          ...(sharedUpdatedData as unknown as Record<string, unknown>),
          updatedFields,
        },
      );
      return domainUpdated;
    };
    if (context) {
      if (context.helpers?.onAfterCommit) {
        context.helpers.onAfterCommit(() =>
          this.invalidateItemCache(id, userId, resolvedProjectId),
        );
      }
      return executeUpdate(context.tx, context.helpers);
    }
    return executeWithPostCommit(
      this.libraryTx,
      (tx, helpers) => executeUpdate(tx, helpers),
      () => this.invalidateItemCache(id, userId, resolvedProjectId),
    );
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
    return executeWithPostCommit(
      this.libraryTx,
      async (tx, helpers) => {
        const updated = await this.command.setMyPublication(
          userId,
          id,
          isMyPublication,
          options,
          tx,
        );
        const effectiveProjectId =
          normalizeProjectScopeId(options?.projectId) ||
          updated.projectId ||
          undefined;
        resolvedProjectId = effectiveProjectId;
        const isSharedProjectItem = Boolean(effectiveProjectId);
        // Personal UserPublication in a shared project must emit to the user's personal sync stream
        const eventScope = isSharedProjectItem
          ? { userId, projectId: undefined }
          : { userId, projectId: effectiveProjectId };
        const domainItem = (ItemsMapper.mapFlattenedState(updated, userId) ??
          ItemsMapper.toDomain(updated)) as ItemDetail;
        await helpers.appendChange(eventScope, {
          entityType: isSharedProjectItem ? 'UserPublication' : 'Item',
          entityId: isSharedProjectItem ? `${userId}:${id}` : id,
          action: 'update',
          version: updated.version,
          data: isSharedProjectItem
            ? {
                itemId: id,
                userId,
                projectId: effectiveProjectId,
                isMyPublication,
              }
            : domainItem,
        });
        await helpers.publishOutbox(
          eventScope,
          id,
          LIBRARY_EVENT_TYPES.ITEM_UPDATED,
          domainItem,
        );
        return domainItem;
      },
      () => this.invalidateItemCache(id, userId, resolvedProjectId),
    );
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
    if (this.searchGateway?.reindexItem) {
      await this.searchGateway
        .reindexItem({
          id,
          userId,
          projectId: effectiveProjectId,
        })
        .catch(() => {});
    }
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
          eventScope, id, LIBRARY_EVENT_TYPES.ITEM_DELETED,
          { id, deletedAt, projectId: validProjectId, cascadedInTx: true },
        );
      }
      return deleted;
    };
    if (context) {
      const deleted = await executeDelete(context.tx, context.helpers);
      if (deleted) {
        context.helpers?.onAfterCommit?.(() =>
          this.invalidateItemCache(id, userId, validProjectId, {
            skipScopeInvalidation,
          }),
        );
      }
      return deleted;
    }
    return executeWithPostCommit(
      this.libraryTx,
      (tx, helpers) => executeDelete(tx, helpers),
      async (deleted) => {
        if (deleted) {
          await this.invalidateItemCache(id, userId, validProjectId, {
            skipScopeInvalidation,
          });
        }
      },
    );
  }
  async restoreItem(
    userId: string,
    id: string,
    expectedVersion?: number,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ) {
    const validProjectId = normalizeProjectScopeId(projectId);
    return executeWithPostCommit(
      this.libraryTx,
      async (tx, helpers) => {
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
        const sharedRestoredData = this.stripPersonalOverlayForSharedScope(
          domainItem,
          effectiveProjectId,
        );
        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: id,
          action: 'update',
          version: restored.version,
          data: sharedRestoredData,
        });
        await helpers.removeTombstone(eventScope, 'Item', id);
        await helpers.publishOutbox(
          eventScope, id, LIBRARY_EVENT_TYPES.ITEM_RESTORED,
          { itemId: id, userId, projectId: effectiveProjectId, restoredAt: new Date().toISOString(), cascadedInTx: true },
        );
        return domainItem;
      },
      () =>
        this.invalidateItemCache(id, userId, validProjectId, {
          skipScopeInvalidation,
        }),
    );
  }
  async purgeItem(
    userId: string,
    id: string,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ): Promise<boolean> {
    const validProjectId = normalizeProjectScopeId(projectId);
    let storagePathsToDelete: string[] = [];
    const purged = await executeWithPostCommit(
      this.libraryTx,
      async (tx, helpers) => {
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
            eventScope, id, LIBRARY_EVENT_TYPES.ITEM_PURGED,
            {
              itemId: id, itemIds: [id], userId, projectId: validProjectId,
              filePaths: purgeRes.storagePaths, purgedAt: new Date().toISOString(),
              cascadedInTx: true, storageDeletedInTx: false,
            },
          );
        }
        return purgeRes.purged;
      },
      async (wasPurged) => {
        if (wasPurged) {
          await this.invalidateItemCache(id, userId, validProjectId, {
            skipScopeInvalidation,
          });
        }
      },
    );
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
    const { succeededIds, failedIds } = await executeWithPostCommit(
      this.libraryTx,
      (tx, helpers) =>
        executeBulkSoftDeleteInTx({
          command: this.command,
          userId,
          itemIds,
          tx,
          helpers,
          validProjectId,
        }),
      async (res) => {
        if (res.succeededIds.length > 0) {
          await this.invalidateBulkItemsCache(
            res.succeededIds,
            userId,
            validProjectId,
          );
        }
      },
    );
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
    const { succeededIds, failedIds } = await executeWithPostCommit(
      this.libraryTx,
      (tx, helpers) =>
        executeBulkRestoreInTx({
          command: this.command,
          query: this.query,
          userId,
          itemIds,
          tx,
          helpers,
          validProjectId,
        }),
      async (res) => {
        if (res.succeededIds.length > 0) {
          await this.invalidateBulkItemsCache(
            res.succeededIds,
            userId,
            validProjectId,
            res.restoredItems.map((r) => r.projectId),
          );
        }
      },
    );
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
    const { succeededIds, failedIds, fileIdsToDelete } =
      await executeWithPostCommit(
        this.libraryTx,
        (tx, helpers) =>
          executeBulkPurgeInTx({
            command: this.command,
            userId,
            itemIds,
            tx,
            helpers,
            validProjectId,
          }),
        async (res) => {
          if (res.succeededIds.length > 0) {
            await this.invalidateBulkItemsCache(
              res.succeededIds,
              userId,
              validProjectId,
            );
          }
        },
      );
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
  async emptyTrash(userId: string, projectId?: string) {
    const validProjectId = normalizeProjectScopeId(projectId);
    const { succeededIds, failedIds, fileIdsToDelete } = await executeWithPostCommit(
      this.libraryTx,
      (tx, helpers) => executeEmptyTrashInTx({ command: this.command, userId, tx, helpers, validProjectId }),
      async (res) => {
        if (res.succeededIds.length > 0) await this.invalidateBulkItemsCache(res.succeededIds, userId, validProjectId);
      },
    );
    if (fileIdsToDelete.length > 0) await this.command.deleteStorageFilesBatch(fileIdsToDelete);
    return { success: true, purgedCount: succeededIds.length, succeededIds, failedIds };
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
    const result = await executeWithPostCommit(
      this.libraryTx,
      async (tx, helpers) => {
        const res = await executePurgeExpiredTrashInTx({
          command: this.command,
          retentionDays,
          limit,
          tx,
          helpers,
        });
        storagePathsToDelete = res.storagePaths;
        purgedItemsList = res.expiredItems ?? [];
        return res;
      },
      () => invalidatePurgedItems(),
    );
    if (storagePathsToDelete.length > 0) {
      await this.command.deleteStorageFilesBatch(storagePathsToDelete);
    }
    return result;
  }
}
