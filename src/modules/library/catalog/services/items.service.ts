import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { QueryRepository } from '../repositories/query.repository';
import { CommandRepository } from '../repositories/command.repository';
import {
  CreateItemData,
  UpdateItemData,
  TypeConversionPreview,
  ConvertTypeOptions,
  IItemReadPort,
  IItemExistencePort,
  QualityAuditCandidateItem,
  DuplicateCandidateItem,
} from '../types/items.types';
import { sanitizeItemTitle } from '../../shared-kernel/utils/bibliographic.utils';
import {
  TransactionService,
  TransactionHelpers,
  LIBRARY_EVENT_TYPES,
  buildItemCreatedOutboxPayload,
  LibraryItemSource,
} from '../../shared-kernel';
import {
  CursorPaginatedResult,
  DocumentFulltextResponse,
} from '../dto/items.dto';
import { RedisCacheService } from '../../../../core/cache/redis.service';
import { LIBRARY_REDIS_KEYS } from '../../shared-kernel/core/constants/redis-keys.constants';
import { TagsService } from './tags.service';
import { TypesService } from './types.service';
import { ItemSyncDelegate } from './item-sync.delegate';
import { ZoteroSchemaValidatorService } from './zotero-schema-validator.service';
import { ItemsMapper } from '../utils/items.mapper';
import { ItemTransformer } from '../utils/item.transformer';
import { BibliographicReference } from '../../shared-kernel/types/bibliographic.types';

import type {
  UpsertSyncItemCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../../shared-kernel/core/types/entity-commands.types';

// Specialized Sub-Services (Divide & Conquer)
import { ItemQueryService } from './item-query.service';
import { ItemFulltextService } from './item-fulltext.service';
import { ItemTypeConversionService } from './item-type-conversion.service';
import { ItemCurationService } from './item-curation.service';

/** Transaction context passed to write methods for composing operations within a parent transaction. */
export interface ItemTransactionContext<TTx = Prisma.TransactionClient> {
  tx: TTx;
  helpers: TransactionHelpers;
}

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
    private readonly typesService: TypesService,
    private readonly transformer: ItemTransformer,
    private readonly queryService: ItemQueryService,
    @Optional()
    private readonly fulltextService: ItemFulltextService = {} as any,
    @Optional()
    private readonly typeConversionService: ItemTypeConversionService = {} as any,
    @Optional()
    private readonly curationService: ItemCurationService = {} as any,
    @Optional()
    private readonly validator: ZoteroSchemaValidatorService = {} as any,
    @Optional() private readonly syncDelegate: ItemSyncDelegate = {} as any,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  /**
   * Invalidates Redis cache entries for an item and affected library lists.
   */
  async invalidateItemCache(
    id: string,
    userId?: string,
    projectId?: string,
  ): Promise<void> {
    if (!this.cache) return;
    try {
      const tasks: Promise<any>[] = [
        this.cache.del(LIBRARY_REDIS_KEYS.item(id)),
        this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
        this.cache.del(LIBRARY_REDIS_KEYS.itemFulltext(id)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(id)),
      ];
      if (userId) {
        tasks.push(
          this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
          this.cache.del(`library:counts:user:${userId}`),
        );
      }
      if (projectId && projectId !== 'user') {
        tasks.push(
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.itemsPattern(`proj:${projectId}`),
          ),
          this.cache.del(`library:counts:proj:${projectId}`),
        );
      }
      await Promise.all(tasks);
    } catch (err: any) {
      this.logger.warn(
        `Failed to invalidate item cache for ${id}: ${err?.message || err}`,
      );
    }
  }

  // ── Delegated Query Operations (ItemQueryService) ──────────────────────────

  async getCounts(userId: string, projectId?: string) {
    return this.queryService.getCounts(userId, projectId);
  }

  async getItem(userId: string, id: string, projectId?: string) {
    return this.queryService.getItem(userId, id, projectId);
  }

  async listItems(
    userId: string,
    options: any,
  ): Promise<CursorPaginatedResult<any>> {
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

  // ── Delegated Fulltext Operations (ItemFulltextService) ───────────────────

  async getFulltext(
    userId: string,
    id: string,
    projectId?: string,
  ): Promise<DocumentFulltextResponse> {
    return this.fulltextService.getFulltext(userId, id, projectId);
  }

  // ── Delegated Type Conversion (ItemTypeConversionService) ─────────────────

  previewTypeConversion(
    rawItem: Record<string, any>,
    targetType: string,
    options: { retainUnmappedInExtra?: boolean } = {},
  ): TypeConversionPreview {
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
    tx?: Prisma.TransactionClient,
  ) {
    return this.typeConversionService.convertItemType(
      userId,
      itemId,
      targetType,
      options,
      tx,
    );
  }

  // ── Delegated Curation Operations (ItemCurationService) ───────────────────

  async parseCitations(
    rawCitations: string,
  ): Promise<BibliographicReference[]> {
    return this.curationService.parseCitations(rawCitations);
  }

  async importItemsToProject(
    userId: string,
    projectId: string,
    itemIds: string[],
  ): Promise<{ success: boolean; importedCount: number }> {
    return this.curationService.importItemsToProject(
      userId,
      projectId,
      itemIds,
    );
  }

  async getMetadataSources(userId: string, itemId: string, projectId?: string) {
    return this.curationService.getMetadataSources(userId, itemId, projectId);
  }

  // ── Core Lifecycle Mutations & Transactions ───────────────────────────────

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
  ): Promise<any> {
    const cleanTitle = sanitizeItemTitle(data.title);
    if (!cleanTitle) {
      throw new UnprocessableEntityException('Item title cannot be empty');
    }
    data.title = cleanTitle;

    const valRes = this.validator.validateAndSanitizeItem(data.itemType, data);
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

    let result: any;
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
  ): Promise<any> {
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
      const valRes = this.validator.validateAndSanitizeItem(
        targetItemType,
        data,
      );
      updatePayload = valRes.sanitizedItem as UpdateItemData;
    }

    if (context) {
      const updated = await this.command.update(
        userId,
        id,
        expectedVersion,
        updatePayload,
        context.tx,
        projectId,
      );

      const effectiveProjectId =
        projectId || (updated as any).projectId || undefined;
      const eventScope = { userId, projectId: effectiveProjectId };

      await context.helpers.appendChange(eventScope, {
        entityType: 'Item',
        entityId: id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await context.helpers.publishOutbox(
        eventScope,
        id,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        updated,
      );

      await this.invalidateItemCache(id, userId, effectiveProjectId);

      return ItemsMapper.toDomain(updated);
    }

    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        return this.updateItem(
          userId,
          id,
          expectedVersion,
          data,
          {
            tx,
            helpers,
          },
          projectId,
        );
      },
    );
    await this.invalidateItemCache(id, userId, projectId);
    return result;
  }

  async setMyPublication(
    userId: string,
    id: string,
    isMyPublication: boolean,
  ): Promise<any> {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const updated = await this.command.setMyPublication(
        userId,
        id,
        isMyPublication,
        tx,
      );

      const effectiveProjectId = (updated as any).projectId || undefined;
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

      await this.invalidateItemCache(id, userId, effectiveProjectId);

      return ItemsMapper.toDomain(updated);
    });
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
  ): Promise<boolean> {
    if (context) {
      const deleted = await this.command.softDelete(
        userId,
        id,
        expectedVersion,
        context.tx,
        projectId,
      );

      if (deleted) {
        const eventScope = { userId, projectId: projectId || undefined };
        await context.helpers.recordTombstone(eventScope, {
          entityType: 'Item',
          entityId: id,
          deletedById: userId,
        });

        await context.helpers.publishOutbox(
          eventScope,
          id,
          'library.item.deleted',
          {
            id,
            deletedAt: new Date(),
            projectId,
          },
        );

        await this.invalidateItemCache(id, userId, projectId);
      }

      return deleted;
    }

    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        return this.deleteItem(
          userId,
          id,
          expectedVersion,
          {
            tx,
            helpers,
          },
          projectId,
        );
      },
    );
    await this.tagsService.invalidateTagsCache(userId, projectId);
    await this.invalidateItemCache(id, userId, projectId);
    return result;
  }

  async restoreItem(
    userId: string,
    id: string,
    expectedVersion?: number,
    projectId?: string,
  ) {
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const restored = await this.command.restore(
          userId,
          id,
          expectedVersion,
          tx,
          projectId,
        );

        const effectiveProjectId =
          (restored as any).projectId || projectId || undefined;
        const eventScope = { userId, projectId: effectiveProjectId };

        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: id,
          action: 'update',
          version: restored.version,
          data: restored,
        });

        await helpers.publishOutbox(eventScope, id, 'library.item.restored', {
          id,
          restoredAt: new Date(),
          projectId: effectiveProjectId,
        });

        return ItemsMapper.toDomain(restored);
      },
    );

    await this.tagsService.invalidateTagsCache(userId, projectId);
    await this.invalidateItemCache(id, userId, projectId);
    return result;
  }

  async purgeItem(
    userId: string,
    id: string,
    projectId?: string,
  ): Promise<boolean> {
    const eventScope = { userId, projectId };
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const purged = await this.command.purge(userId, id, tx, projectId);

        await helpers.recordTombstone(eventScope, {
          entityType: 'Item',
          entityId: id,
        });

        await helpers.publishOutbox(eventScope, id, 'library.item.purged', {
          id,
          purgedAt: new Date(),
        });

        return purged;
      },
    );

    await this.tagsService.invalidateTagsCache(userId, projectId);
    await this.invalidateItemCache(id, userId, projectId);
    return result;
  }

  async bulkTrash(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ success: boolean; count: number; trashedIds: string[] }> {
    if (!itemIds || itemIds.length === 0) {
      return { success: true, count: 0, trashedIds: [] };
    }
    const trashedIds: string[] = [];
    for (const itemId of itemIds) {
      try {
        const deleted = await this.deleteItem(
          userId,
          itemId,
          undefined,
          undefined,
          projectId,
        );
        if (deleted) trashedIds.push(itemId);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to move item ${itemId} to trash: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { success: true, count: trashedIds.length, trashedIds };
  }

  async bulkRestore(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ success: boolean; count: number; restoredIds: string[] }> {
    if (!itemIds || itemIds.length === 0) {
      return { success: true, count: 0, restoredIds: [] };
    }
    const restoredIds: string[] = [];
    for (const itemId of itemIds) {
      try {
        await this.restoreItem(userId, itemId, undefined, projectId);
        restoredIds.push(itemId);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to restore item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { success: true, count: restoredIds.length, restoredIds };
  }

  async bulkPurge(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ success: boolean; count: number; purgedIds: string[] }> {
    if (!itemIds || itemIds.length === 0) {
      return { success: true, count: 0, purgedIds: [] };
    }
    const purgedIds: string[] = [];
    for (const itemId of itemIds) {
      try {
        const purged = await this.purgeItem(userId, itemId, projectId);
        if (purged) purgedIds.push(itemId);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to purge item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { success: true, count: purgedIds.length, purgedIds };
  }

  async getRelatedItems(userId: string, itemId: string, projectId?: string) {
    const item = await this.query.findById(userId, itemId, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const relations = await this.query.getRelations(itemId);
    return {
      relatedItems: relations,
      total: relations.length,
    };
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
    const sourceItem = await this.query.findById(
      userId,
      sourceItemId,
      projectId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    const rawIds = [
      ...(Array.isArray(data.targetItemIds) ? data.targetItemIds : []),
      ...(data.targetItemId ? [data.targetItemId] : []),
    ];
    const targetIds = Array.from(
      new Set(rawIds.filter((id) => id && id !== sourceItemId)),
    );

    if (targetIds.length === 0) {
      throw new BadRequestException(
        'At least one valid target item ID (different from source) must be provided',
      );
    }

    const type = data.relationType ?? 'related';
    const now = new Date().toISOString();
    const linkedRelations = [];

    // Batch fetch target items to eliminate N+1 queries
    let targetItemMap = new Map<string, any>();
    if (this.query.findByIds && targetIds.length > 0) {
      const targetItems = await this.query.findByIds(
        userId,
        targetIds,
        projectId,
      );
      if (targetItems && targetItems.length > 0) {
        targetItemMap = new Map(targetItems.map((item) => [item.id, item]));
      }
    }

    for (const targetId of targetIds) {
      const targetItem =
        targetItemMap.get(targetId) ||
        (await this.query.findById(userId, targetId, projectId));
      if (!targetItem) continue;

      const relation = {
        id: randomUUID(),
        targetItemId: targetId,
        relationType: type,
        note: data.note,
        linkedAt: now,
      };

      await this.command.putRelation(sourceItemId, relation);
      linkedRelations.push({
        ...relation,
        targetTitle: targetItem.title,
      });
    }

    return {
      success: true,
      link: linkedRelations[0] || null,
      links: linkedRelations,
      totalLinked: linkedRelations.length,
      message:
        linkedRelations.length === 1
          ? `Linked "${sourceItem.title}" to "${linkedRelations[0].targetTitle}"`
          : `Linked ${linkedRelations.length} item(s) to "${sourceItem.title}"`,
    };
  }

  async unlinkItems(
    userId: string,
    sourceItemId: string,
    targetItemId: string,
    projectId?: string,
  ) {
    const sourceItem = await this.query.findById(
      userId,
      sourceItemId,
      projectId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    await this.command.removeRelation(sourceItemId, targetItemId);

    return {
      success: true,
      unlinked: true,
      message: `Removed relation between "${sourceItem.title}" and "${targetItemId}"`,
    };
  }

  // ── Sync Protocol Delegate ────────────────────────────────────────────────

  /**
   * Sync protocol adapter: transactional upsert for a Item from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncItemCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
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
    return this.syncDelegate.deleteFromSync(command, tx, helpers);
  }
}

export const ItemsService = ItemService;
export type ItemsService = ItemService;
