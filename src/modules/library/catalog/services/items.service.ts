import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import {
  CreateItemData,
  UpdateItemData,
  TypeConversionPreview,
  ConvertTypeOptions,
  IItemReadPort,
  IItemExistencePort,
  QualityAuditCandidateItem,
  DuplicateCandidateItem,
  ItemDetail,
  ItemTransactionContext,
} from '@/modules/library/catalog/types/items.types';
import { sanitizeItemTitle } from '@/modules/library/core';
import {
  TransactionService,
  TransactionHelpers,
  LIBRARY_EVENT_TYPES,
  buildItemCreatedOutboxPayload,
  LibraryItemSource,
} from '@/modules/library/core';
import {
  CursorPaginatedResult,
  DocumentFulltextResponse,
} from '@/modules/library/catalog/dto/items.dto';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { TagsService } from './tags.service';
import { ItemSyncDelegate } from './item-sync.delegate';
import { ZoteroSchemaValidatorService } from './zotero-schema-validator.service';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import { BibliographicReference } from '@/modules/library/core/types/bibliographic.types';

import type {
  UpsertSyncItemCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '@/modules/library/core/types/entity-commands.types';

// Specialized Sub-Services (Divide & Conquer)
import { ItemQueryService } from './item-query.service';
import { ItemFulltextService } from './item-fulltext.service';
import { ItemTypeConversionService } from './item-type-conversion.service';
import { ItemCurationService } from './item-curation.service';
import { ItemRelationsService } from './item-relations.service';
import { ItemBulkService } from './item-bulk.service';
import { ItemCacheService } from './item-cache.service';
import { ItemLifecycleService } from './item-lifecycle.service';

export type { ItemTransactionContext };

/**
 * ItemService — Root Coordinator and Lifecycle Orchestrator for Library Items.
 * Handles core creation, updates, deletions, bulk operations, and outbox event publishing.
 * Delegates querying, fulltext tree building, type conversion, and scholarly curation
 * to specialized domain services following Single Responsibility & Clean Architecture.
 */
@Injectable()
export class ItemService implements IItemReadPort, IItemExistencePort {
  private readonly logger = new Logger(ItemService.name);

  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    private readonly libraryTx: TransactionService,
    private readonly tagsService: TagsService,
    private readonly queryService: ItemQueryService,
    @Optional()
    private readonly fulltextService?: ItemFulltextService,
    @Optional()
    private readonly typeConversionService?: ItemTypeConversionService,
    @Optional()
    private readonly curationService?: ItemCurationService,
    @Optional()
    private readonly validator?: ZoteroSchemaValidatorService,
    @Optional() private readonly syncDelegate?: ItemSyncDelegate,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() relationsService?: ItemRelationsService,
    @Optional() bulkService?: ItemBulkService,
    @Optional() itemCache?: ItemCacheService,
    @Optional() lifecycleService?: ItemLifecycleService,
  ) {
    this.relationsService =
      relationsService ?? new ItemRelationsService(this.query, this.command);
    this.bulkService = bulkService ?? new ItemBulkService();
    this.itemCache =
      itemCache ?? new ItemCacheService(this.tagsService, this.cache);
    this.lifecycleService =
      lifecycleService ??
      new ItemLifecycleService(
        this.command,
        this.libraryTx,
        this.tagsService,
        this.itemCache,
      );
  }

  private readonly relationsService: ItemRelationsService;
  private readonly bulkService: ItemBulkService;
  private readonly itemCache: ItemCacheService;
  private readonly lifecycleService: ItemLifecycleService;

  /**
   * Invalidates Redis cache entries for an item and affected library lists.
   */
  async invalidateItemCache(
    id: string,
    userId?: string,
    projectId?: string,
    options?: { skipScopeInvalidation?: boolean },
  ): Promise<void> {
    return this.itemCache.invalidateItemCache(id, userId, projectId, options);
  }

  async invalidateScopeCachesOnce(
    userId: string,
    projectId?: string,
  ): Promise<void> {
    return this.itemCache.invalidateScopeCachesOnce(userId, projectId);
  }

  // Delegated Query Operations (ItemQueryService)

  async getCounts(
    userId: string,
    projectId?: string,
    accessHint?: Parameters<ItemQueryService['getCounts']>[2],
  ) {
    return this.queryService.getCounts(userId, projectId, accessHint);
  }

  async getPermissions(
    userId: string,
    projectId?: string,
    accessHint?: Parameters<ItemQueryService['getPermissions']>[2],
  ) {
    return this.queryService.getPermissions(userId, projectId, accessHint);
  }

  async getItem(userId: string, id: string, projectId?: string) {
    return this.queryService.getItem(userId, id, projectId);
  }

  async listItems(
    userId: string,
    options: Parameters<ItemQueryService['listItems']>[1],
  ): Promise<CursorPaginatedResult<ItemDetail | Record<string, unknown>>> {
    return this.queryService.listItems(userId, options);
  }

  async getItemSnapshot(userId: string, itemId: string) {
    return this.queryService.getItemSnapshot(userId, itemId);
  }

  async getItemSnapshots(userId: string, itemIds: string[]) {
    return this.queryService.getItemSnapshots(userId, itemIds);
  }

  async exists(userId: string, itemId: string, projectId?: string) {
    return this.queryService.exists(userId, itemId, projectId);
  }

  async assertExists(userId: string, itemId: string, projectId?: string) {
    return this.queryService.assertExists(userId, itemId, projectId);
  }

  async existMany(userId: string, itemIds: string[], projectId?: string) {
    return this.queryService.existMany(userId, itemIds, projectId);
  }

  async validateItemsBelongToUser(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ) {
    return this.queryService.validateItemsBelongToUser(
      userId,
      itemIds,
      projectId,
    );
  }

  async findById(userId: string, itemId: string, projectId?: string) {
    return this.queryService.findById(userId, itemId, projectId);
  }

  async findByIds(userId: string, itemIds: string[], projectId?: string) {
    return this.queryService.findByIds(userId, itemIds, projectId);
  }

  async findByDoi(userId: string, doi: string, projectId?: string) {
    return this.queryService.findByDoi(userId, doi, projectId);
  }

  async findSummaryById(userId: string, itemId: string, projectId?: string) {
    return this.queryService.findSummaryById(userId, itemId, projectId);
  }

  async findSummariesByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ) {
    return this.queryService.findSummariesByIds(userId, itemIds, projectId);
  }

  async findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<QualityAuditCandidateItem[]> {
    return this.queryService.findQualityAuditItems(userId, limit, projectId);
  }

  async findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<DuplicateCandidateItem[]> {
    return this.queryService.findDuplicateCandidateItems(
      userId,
      limit,
      projectId,
    );
  }

  async findCandidateItemsForQualityAudit(
    limit: number,
  ): Promise<QualityAuditCandidateItem[]> {
    return this.queryService.findCandidateItemsForQualityAudit(limit);
  }

  async findCandidateItemsForDuplicateDetection(
    limit: number,
  ): Promise<DuplicateCandidateItem[]> {
    return this.queryService.findCandidateItemsForDuplicateDetection(limit);
  }

  // Delegated Fulltext Operations (ItemFulltextService)

  async getFulltext(
    userId: string,
    id: string,
    projectId?: string,
  ): Promise<DocumentFulltextResponse> {
    if (!this.fulltextService) {
      throw new BadRequestException('Fulltext service unavailable');
    }
    return this.fulltextService.getFulltext(userId, id, projectId);
  }

  // Delegated Type Conversion (ItemTypeConversionService)

  previewTypeConversion(
    rawItem: Record<string, unknown>,
    targetType: string,
    options: { retainUnmappedInExtra?: boolean } = {},
  ): TypeConversionPreview {
    if (!this.typeConversionService) {
      throw new BadRequestException('Type conversion service unavailable');
    }
    return this.typeConversionService.previewTypeConversion(
      rawItem,
      targetType,
      options,
    );
  }

  async convertItemType(
    userId: string,
    itemId: string,
    targetType: string,
    options: ConvertTypeOptions = {},
    projectIdOrTx?: string | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    if (!this.typeConversionService) {
      throw new BadRequestException('Type conversion service unavailable');
    }
    return this.typeConversionService.convertItemType(
      userId,
      itemId,
      targetType,
      options,
      projectIdOrTx,
      tx,
    );
  }

  // Delegated Curation Operations (ItemCurationService)

  async parseCitations(
    rawCitations: string,
  ): Promise<BibliographicReference[]> {
    if (!this.curationService) return [];
    return this.curationService.parseCitations(rawCitations);
  }

  async importItemsToProject(
    userId: string,
    projectId: string,
    itemIds: string[],
  ): Promise<{ success: boolean; importedCount: number }> {
    if (!this.curationService) {
      throw new BadRequestException('Curation service unavailable');
    }
    return this.curationService.importItemsToProject(
      userId,
      projectId,
      itemIds,
    );
  }

  async getMetadataSources(userId: string, itemId: string, projectId?: string) {
    if (!this.curationService) return { sources: [] };
    return this.curationService.getMetadataSources(userId, itemId, projectId);
  }

  // Core Lifecycle Mutations & Transactions

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

    const effectiveProjectId =
      projectId || context?.projectId || itemPayload.projectId || undefined;
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

    await this.tagsService.invalidateTagsCache(userId, effectiveProjectId);
    if (this.cache) {
      const scopeKey =
        effectiveProjectId && effectiveProjectId !== 'user'
          ? `proj:${effectiveProjectId}`
          : userId;
      await this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(scopeKey));
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

    // Resolve target itemType
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

    let resolvedProjectId = projectId;

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
        projectId,
      );

      const effectiveProjectId = projectId || updated.projectId || undefined;
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

    if (context) {
      const res = await executeUpdate(context.tx, context.helpers);
      await this.invalidateItemCache(id, userId, resolvedProjectId);
      return res;
    }

    const res = await this.libraryTx.executeInTransaction(executeUpdate);
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
    },
  ): Promise<ItemDetail> {
    let resolvedProjectId: string | undefined;
    const res = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const updated = options
          ? await this.command.setMyPublication(
              userId,
              id,
              isMyPublication,
              options,
              tx,
            )
          : await this.command.setMyPublication(
              userId,
              id,
              isMyPublication,
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

    const effectiveProjectId = projectId ?? item.projectId ?? undefined;
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
    return this.lifecycleService.deleteItem(
      userId,
      id,
      expectedVersion,
      context,
      projectId,
      skipScopeInvalidation,
    );
  }

  async restoreItem(
    userId: string,
    id: string,
    expectedVersion?: number,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ) {
    return this.lifecycleService.restoreItem(
      userId,
      id,
      expectedVersion,
      projectId,
      skipScopeInvalidation,
    );
  }

  async purgeItem(
    userId: string,
    id: string,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ): Promise<boolean> {
    return this.lifecycleService.purgeItem(
      userId,
      id,
      projectId,
      skipScopeInvalidation,
    );
  }

  async bulkTrash(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ success: boolean; count: number; trashedIds: string[] }> {
    return this.bulkService.bulkTrash(this, userId, itemIds, projectId);
  }

  async bulkRestore(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ success: boolean; count: number; restoredIds: string[] }> {
    return this.bulkService.bulkRestore(this, userId, itemIds, projectId);
  }

  async bulkPurge(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ success: boolean; count: number; purgedIds: string[] }> {
    return this.bulkService.bulkPurge(this, userId, itemIds, projectId);
  }

  async getRelatedItems(userId: string, itemId: string, projectId?: string) {
    return this.relationsService.getRelatedItems(userId, itemId, projectId);
  }

  async linkItems(
    userId: string,
    sourceItemId: string,
    data: {
      targetItemId?: string;
      targetItemIds?: string[];
      relationType?: string;
      note?: string;
    },
    projectId?: string,
  ) {
    return this.relationsService.linkItems(
      userId,
      sourceItemId,
      data,
      projectId,
    );
  }

  async unlinkItems(
    userId: string,
    sourceItemId: string,
    targetItemId: string,
    projectId?: string,
  ) {
    return this.relationsService.unlinkItems(
      userId,
      sourceItemId,
      targetItemId,
      projectId,
    );
  }

  // Sync Protocol Delegate

  /**
   * Sync protocol adapter: transactional upsert for a Item from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncItemCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    if (!this.syncDelegate) {
      throw new BadRequestException('Sync delegate unavailable');
    }
    return this.syncDelegate.upsertFromSync(command, tx, helpers);
  }

  /**
   * Sync protocol adapter: transactional soft-delete for a Item from an external sync batch.
   */
  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    if (!this.syncDelegate) {
      throw new BadRequestException('Sync delegate unavailable');
    }
    return this.syncDelegate.deleteFromSync(command, tx, helpers);
  }
}
