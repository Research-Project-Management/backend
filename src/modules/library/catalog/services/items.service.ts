import {
  Injectable,
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
  LIBRARY_EVENT_TYPES,
  buildItemCreatedOutboxPayload,
  LibraryItemSource,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { TagsService } from './tags.service';
import { ItemCacheCoordinator } from './item-cache.coordinator';
import { ZoteroSchemaValidatorService } from './zotero-schema-validator.service';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
export type { ItemTransactionContext };
@Injectable()
export class ItemService {
  private readonly logger = new Logger(ItemService.name);
  private readonly cacheCoordinator: ItemCacheCoordinator;
  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    private readonly libraryTx: TransactionService,
    private readonly tagsService: TagsService,
    @Optional()
    private readonly validator?: ZoteroSchemaValidatorService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() cacheCoordinator?: ItemCacheCoordinator,
  ) {
    this.cacheCoordinator =
      cacheCoordinator ?? new ItemCacheCoordinator(cache, tagsService);
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
    return item ? ItemsMapper.toDomain(item) : null;
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
      await helpers.appendChange(
        { userId, projectId: effectiveProjectId },
        {
          entityType: 'Item',
          entityId: item.id,
          action: 'create',
          version: item.version,
          data: item,
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
      return ItemsMapper.toDomain(item);
    };
    let result: ItemDetail;
    if (context?.tx && context?.helpers) {
      result = await execute(context.tx, context.helpers);
    } else {
      result = await this.libraryTx.executeInTransaction(execute);
    }
    await this.invalidateScopeListCache(userId, effectiveProjectId);
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
    let targetItemType = data.itemType;
    if (!targetItemType) {
      const existing = await this.query.findById(
        userId,
        id,
        projectId,
        context?.tx,
        false,
        false,
      );
      if (existing) {
        targetItemType = existing.itemType || existing.type || 'journalArticle';
      }
    }
    let updatePayload = data;
    if (targetItemType) {
      const valRes = this.validator?.validateAndSanitizeItem
        ? this.validator.validateAndSanitizeItem(targetItemType, data)
        : { sanitizedItem: data, warnings: [] };
      updatePayload = valRes.sanitizedItem;
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
      await helpers.appendChange(eventScope, {
        entityType: 'Item',
        entityId: id,
        action: 'update',
        version: updated.version,
        data: updated,
      });
      await helpers.publishOutbox(
        eventScope,
        id,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        updated,
      );
      return ItemsMapper.toDomain(updated);
    };
    const res = context
      ? await executeUpdate(context.tx, context.helpers)
      : await this.libraryTx.executeInTransaction(executeUpdate);
    await this.invalidateItemCache(id, userId, resolvedProjectId);
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
    const res = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
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
        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: id,
          action: 'update',
          version: updated.version,
          data: updated,
        });
        await helpers.publishOutbox(
          eventScope,
          id,
          LIBRARY_EVENT_TYPES.ITEM_UPDATED,
          updated,
        );
        return ItemsMapper.toDomain(updated);
      },
    );
    await this.invalidateItemCache(id, userId, resolvedProjectId);
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
      await helpers.publishOutbox(eventScope, id, 'library.item.reindexed', {
        itemId: id,
        userId,
        projectId: effectiveProjectId,
      });
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
        await helpers.recordTombstone(eventScope, {
          entityType: 'Item',
          entityId: id,
        });
        await helpers.publishOutbox(
          eventScope,
          id,
          LIBRARY_EVENT_TYPES.ITEM_DELETED,
          { id, deletedAt: new Date(), projectId: validProjectId },
        );
      }
      return deleted;
    };
    const deleted = context
      ? await executeDelete(context.tx, context.helpers)
      : await this.libraryTx.executeInTransaction(executeDelete);
    if (deleted) {
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
    const res = await this.libraryTx.executeInTransaction(
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
        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: id,
          action: 'update',
          version: restored.version,
          data: restored,
        });
        await helpers.removeTombstone(eventScope, 'Item', id);
        await helpers.publishOutbox(eventScope, id, 'library.item.restored', {
          itemId: id,
          userId,
          projectId: effectiveProjectId,
          restoredAt: new Date().toISOString(),
        });
        return ItemsMapper.toDomain(restored);
      },
    );
    await this.invalidateItemCache(id, userId, validProjectId, {
      skipScopeInvalidation,
    });
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
    const purged = await this.libraryTx.executeInTransaction(
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
          await helpers.recordTombstone(
            { userId, projectId: validProjectId },
            { entityType: 'Item', entityId: id },
          );
          await helpers.appendChange(
            { userId, projectId: validProjectId },
            {
              entityType: 'Item',
              entityId: id,
              action: 'delete',
              version: 0,
            },
          );
          await helpers.publishOutbox(
            { userId, projectId: validProjectId },
            id,
            'library.item.purged',
            {
              itemId: id,
              userId,
              projectId: validProjectId,
              purgedAt: new Date().toISOString(),
            },
          );
        }
        return purgeRes.purged;
      },
    );
    if (storagePathsToDelete.length > 0) {
      await this.command.deleteStorageFilesBatch(storagePathsToDelete);
    }
    if (purged) {
      await this.invalidateItemCache(id, userId, validProjectId, {
        skipScopeInvalidation,
      });
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
    const { succeededIds, failedIds } =
      await this.libraryTx.executeInTransaction(async (tx, helpers) => {
        const res = await this.command.softDeleteMany(userId, itemIds, tx, validProjectId);
        if (res.succeededIds.length > 0) {
          const eventScope = { userId, projectId: validProjectId };
          const deletedAt = new Date();
          await helpers.recordTombstonesBatch(
            eventScope,
            res.succeededIds.map((id) => ({
              entityType: 'Item',
              entityId: id,
            })),
          );
          await helpers.publishOutboxBatch(
            eventScope,
            res.succeededIds.map((id) => ({
              aggregateId: id,
              eventType: LIBRARY_EVENT_TYPES.ITEM_DELETED,
              payload: { id, deletedAt, projectId: validProjectId },
            })),
          );
        }
        return res;
      });
    if (succeededIds.length > 0) {
      await this.invalidateBulkItemsCache(
        succeededIds,
        userId,
        validProjectId,
      );
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
    const { succeededIds, failedIds, restoredItems } =
      await this.libraryTx.executeInTransaction(async (tx, helpers) => {
        const res = await this.command.restoreMany(userId, itemIds, tx, validProjectId);
        if (res.restoredItems.length > 0) {
          const restoredFullItems = await this.query.findByIds(
            userId,
            res.succeededIds,
            validProjectId,
            tx,
            false,
          );
          const fullItemMap = new Map(
            (restoredFullItems || []).map((it) => [it.id, it]),
          );
          const restoredAt = new Date().toISOString();
          const changeInputs = res.restoredItems.map((restored) => {
            const effectiveProjectId =
              validProjectId || restored.projectId || undefined;
            const fullItem = fullItemMap.get(restored.id);
            return {
              userId,
              projectId: effectiveProjectId,
              entityType: 'Item',
              entityId: restored.id,
              action: 'update' as const,
              version: restored.version,
              data: fullItem
                ? ItemsMapper.toDomain(fullItem)
                : {
                    id: restored.id,
                    version: restored.version,
                    projectId: effectiveProjectId,
                  },
            };
          });
          await helpers.appendChangesBatch(changeInputs);
          await helpers.removeTombstonesBatch(
            { userId, projectId: validProjectId },
            'Item',
            res.restoredItems.map((r) => r.id),
          );
          const outboxInputs = res.restoredItems.map((restored) => {
            const effectiveProjectId =
              validProjectId || restored.projectId || undefined;
            return {
              userId,
              projectId: effectiveProjectId,
              aggregateId: restored.id,
              eventType: 'library.item.restored',
              payload: {
                itemId: restored.id,
                userId,
                projectId: effectiveProjectId,
                restoredAt,
              },
            };
          });
          await helpers.publishOutboxBatch(outboxInputs);
        }
        return res;
      });
    if (succeededIds.length > 0) {
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
    const { succeededIds, failedIds, fileIdsToDelete } =
      await this.libraryTx.executeInTransaction(async (tx, helpers) => {
        const res = await this.command.purgeMany(userId, itemIds, tx, validProjectId);
        if (res.succeededIds.length > 0) {
          const eventScope = { userId, projectId: validProjectId };
          const purgedAt = new Date().toISOString();
          await helpers.recordTombstonesBatch(eventScope, res.succeededIds.map((id) => ({ entityType: 'Item', entityId: id })));
          await helpers.appendChangesBatch(eventScope, res.succeededIds.map((id) => ({ entityType: 'Item', entityId: id, action: 'delete', version: 0 })));
          await helpers.publishOutboxBatch(
            eventScope,
            res.succeededIds.map((id) => ({
              aggregateId: id,
              eventType: 'library.item.purged',
              payload: {
                itemId: id,
                userId,
                projectId: validProjectId,
                purgedAt,
              },
            })),
          );
        }
        return res;
      });
    if (fileIdsToDelete.length > 0) {
      await this.command.deleteStorageFilesBatch(fileIdsToDelete);
    }
    if (succeededIds.length > 0) {
      await this.invalidateBulkItemsCache(
        succeededIds,
        userId,
        validProjectId,
      );
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
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);
        const expiredItems = await tx.item.findMany({
          where: { deletedAt: { lt: cutoff } },
          select: { id: true, userId: true, projectId: true },
          orderBy: { deletedAt: 'asc' },
          take: limit,
        });
        const expiredNotes = await tx.note.findMany({
          where: { deletedAt: { lt: cutoff } },
          select: { id: true, userId: true, projectId: true },
          orderBy: { deletedAt: 'asc' },
          take: limit,
        });
        const expiredCollections = await tx.collection.findMany({
          where: { deletedAt: { lt: cutoff } },
          select: { id: true, userId: true, projectId: true },
          orderBy: { deletedAt: 'asc' },
          take: limit,
        });
        const res = await this.command.purgeExpiredTrash(
          retentionDays,
          limit,
          tx,
        );
        storagePathsToDelete = res.storagePaths;
        for (const it of expiredItems) {
          const scope = {
            userId: it.userId,
            projectId: it.projectId ?? undefined,
          };
          await helpers.recordTombstone(scope, {
            entityType: 'Item',
            entityId: it.id,
          });
          await helpers.appendChange(scope, {
            entityType: 'Item',
            entityId: it.id,
            action: 'delete',
            version: 0,
          });
        }
        for (const n of expiredNotes) {
          const scope = {
            userId: n.userId,
            projectId: n.projectId ?? undefined,
          };
          await helpers.recordTombstone(scope, {
            entityType: 'Note',
            entityId: n.id,
          });
          await helpers.appendChange(scope, {
            entityType: 'Note',
            entityId: n.id,
            action: 'delete',
            version: 0,
          });
        }
        for (const c of expiredCollections) {
          const scope = {
            userId: c.userId,
            projectId: c.projectId ?? undefined,
          };
          await helpers.recordTombstone(scope, {
            entityType: 'Collection',
            entityId: c.id,
          });
          await helpers.appendChange(scope, {
            entityType: 'Collection',
            entityId: c.id,
            action: 'delete',
            version: 0,
          });
        }
        return res;
      },
    );
    if (storagePathsToDelete.length > 0) {
      await this.command.deleteStorageFilesBatch(storagePathsToDelete);
    }
    return result;
  }
}
