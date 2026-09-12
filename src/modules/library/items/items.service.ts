import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma, RagStatus } from '@prisma/client';
import { QueryRepository } from './repositories/query.repository';
import { CommandRepository } from './repositories/command.repository';
import {
  CreateItemData,
  UpdateItemData,
} from './types/items.types';
import {
  TransactionService,
  TransactionHelpers,
} from '../outbox/transaction.service';
import {
  LIBRARY_EVENT_TYPES,
  SYNC_EVENT_TYPES,
  LibraryItemSource,
  buildItemCreatedOutboxPayload,
} from '../outbox/outbox.events';
import { CursorPaginatedResult } from './dto/items.dto';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveTenantWorkspaceId } from '../../../core/utils/tenant.util';
import { normalizeTags } from '../tags/utils/tags.utils';
import { TagsService } from '../tags/tags.service';
import { CollectionsService } from '../collections/collections.service';
import { TypesService } from '../types/types.service';
import { RagProvider } from '../search/providers/rag.provider';
import { ItemsMapper } from './mappers/items.mapper';
import { TypeConversionPreview, ConvertTypeOptions } from './types/items.types';
import { ItemTransformer } from './transformers/item.transformer';
import { randomUUID } from 'crypto';
import {
  IItemReadPort,
  IItemExistencePort,
  ItemDetail,
} from './ports/items.ports';

import type {
  UpsertSyncItemCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../common/types/sync.types';

/** Transaction context passed to write methods for composing operations within a parent transaction. */
export interface ItemTransactionContext {
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
}

import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
} from './constants/items.constants';

@Injectable()
export class ItemsService implements IItemReadPort, IItemExistencePort {
  private readonly logger = new Logger(ItemsService.name);

  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    private readonly libraryTx: TransactionService,
    private readonly prisma: PrismaService,
    private readonly tagsService: TagsService,
    private readonly collectionsService: CollectionsService,
    private readonly typesService: TypesService,
    private readonly rag: RagProvider,
    private readonly transformer: ItemTransformer,
  ) {}

  private resolveWorkspaceId(workspaceId: string): Promise<string> {
    return resolveTenantWorkspaceId(this.prisma, workspaceId);
  }

  private mapFlattenedState(
    item: Record<string, any>,
    userId?: string,
  ): Record<string, any> | null {
    return ItemsMapper.mapFlattenedState(item, userId);
  }

  async getItem(workspaceId: string, id: string, userId?: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const item = await this.query.findById(canonicalWorkspaceId, id);
    if (!item) return null;
    return this.mapFlattenedState(item, userId);
  }

  async getFulltext(workspaceId: string, id: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.getFulltext(canonicalWorkspaceId, id);
  }

  async listItems(
    workspaceId: string,
    options: {
      view?: 'all' | 'recent' | 'unfiled' | 'trash';
      userId?: string;
      collectionId?: string;
      tagId?: string;
      search?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<CursorPaginatedResult<any>> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const limit = Math.min(options.limit ?? 50, 100);
    const [totalCount, rawItems] = await Promise.all([
      this.query.count(canonicalWorkspaceId, options),
      this.query.findMany(canonicalWorkspaceId, {
        ...options,
        limit,
      }),
    ]);

    let hasNextPage = false;
    let nextCursor: string | undefined;

    if (rawItems.length > limit) {
      hasNextPage = true;
      rawItems.pop();
      nextCursor = rawItems[rawItems.length - 1]?.id;
    }

    const items = rawItems.map((it) =>
      this.mapFlattenedState(it, options.userId),
    );

    return {
      items,
      meta: {
        cursor: nextCursor,
        hasNextPage,
        totalCount,
      },
    };
  }

  async createItem(
    workspaceId: string,
    data: CreateItemData,
    context?: Partial<ItemTransactionContext> & {
      source?: LibraryItemSource;
    },
  ): Promise<any> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);

    const execute = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => {
      const item = await this.command.create(canonicalWorkspaceId, data, tx);

      await helpers.appendChange(canonicalWorkspaceId, {
        entityType: 'Item',
        entityId: item.id,
        action: 'create',
        version: item.version,
        data: item,
      });

      const payload = buildItemCreatedOutboxPayload({
        itemId: item.id,
        workspaceId: canonicalWorkspaceId,
        title: item.title,
        source: context?.source ?? 'manual',
        doi: item.doi,
      });

      await helpers.publishOutbox(
        canonicalWorkspaceId,
        item.id,
        LIBRARY_EVENT_TYPES.ITEM_CREATED,
        payload,
      );

      return ItemsMapper.toDomain(item);
    };

    if (context?.tx && context?.helpers) {
      return execute(context.tx, context.helpers);
    }

    return this.libraryTx.executeInTransaction(execute);
  }

  async updateItem(
    workspaceId: string,
    id: string,
    expectedVersion: number | undefined,
    data: UpdateItemData,
    context?: ItemTransactionContext,
  ): Promise<any> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    if (context) {
      const updated = await this.command.update(
        canonicalWorkspaceId,
        id,
        expectedVersion,
        data,
        context.tx,
      );

      await context.helpers.appendChange(canonicalWorkspaceId, {
        entityType: 'Item',
        entityId: id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await context.helpers.publishOutbox(
        canonicalWorkspaceId,
        id,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        updated,
      );

      return ItemsMapper.toDomain(updated);
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      return this.updateItem(canonicalWorkspaceId, id, expectedVersion, data, {
        tx,
        helpers,
      });
    });
  }

  private async executePaperRagIndexing(item: any): Promise<void> {
    await this.command.updateRagStatus(item.id, {
      ragStatus: RagStatus.pending,
      ragLastAttemptAt: new Date(),
    });
    try {
      const result = await this.rag.indexPaper(item);
      await this.command.updateRagStatus(item.id, {
        ragDocId: result.docId,
        ragStatus: 'indexed',
        ragIndexedAt: new Date(),
        ragError: null,
      });
      this.logger.log(
        `Paper ${item.id} successfully indexed into Qdrant (docId: ${result.docId})`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Indexing failed';
      await this.command.updateRagStatus(item.id, {
        ragStatus: 'failed',
        ragError: message,
      });
      this.logger.error(`Failed to index paper ${item.id}: ${message}`);
    }
  }

  async reindexItem(workspaceId: string, id: string, userId: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const item = await this.query.findById(canonicalWorkspaceId, id);
    if (!item) {
      throw new NotFoundException(
        `Item ${id} not found in workspace ${canonicalWorkspaceId}`,
      );
    }

    await this.libraryTx.executeInTransaction(async (_tx, helpers) => {
      await helpers.publishOutbox(
        canonicalWorkspaceId,
        id,
        'library.item.reindexed',
        {
          itemId: id,
          workspaceId: canonicalWorkspaceId,
          userId,
        },
      );
    });

    this.executePaperRagIndexing(item).catch((err) => {
      this.logger.error(`Failed to index paper ${id}: ${err.message}`);
    });

    return {
      success: true,
      message: 'Item re-indexing started',
      itemId: id,
    };
  }

  async deleteItem(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
    context?: ItemTransactionContext,
  ): Promise<boolean> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    if (context) {
      const deleted = await this.command.softDelete(
        canonicalWorkspaceId,
        id,
        expectedVersion,
        context.tx,
      );

      if (deleted) {
        await context.helpers.recordTombstone(canonicalWorkspaceId, {
          entityType: 'Item',
          entityId: id,
        });

        await context.helpers.publishOutbox(
          canonicalWorkspaceId,
          id,
          'library.item.deleted',
          {
            id,
            deletedAt: new Date(),
          },
        );
      }

      return deleted;
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const deleted = await this.deleteItem(
        canonicalWorkspaceId,
        id,
        expectedVersion,
        {
          tx,
          helpers,
        },
      );
      await this.tagsService.invalidateTagsCache(canonicalWorkspaceId);
      return deleted;
    });
  }

  async restoreItem(workspaceId: string, id: string, expectedVersion?: number) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const restored = await this.command.restore(
        canonicalWorkspaceId,
        id,
        expectedVersion,
        tx,
      );

      await helpers.appendChange(canonicalWorkspaceId, {
        entityType: 'Item',
        entityId: id,
        action: 'update',
        version: restored.version,
        data: restored,
      });

      await helpers.publishOutbox(
        canonicalWorkspaceId,
        id,
        'library.item.restored',
        {
          id,
          restoredAt: new Date(),
        },
      );

      await this.tagsService.invalidateTagsCache(canonicalWorkspaceId);

      // Normalize through mapper so response shape is consistent with
      // getItem / createItem / updateItem (creators, fileUrl, tags, etc.)
      return ItemsMapper.toDomain(restored);
    });
  }

  async purgeItem(workspaceId: string, id: string): Promise<boolean> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const purged = await this.command.purge(canonicalWorkspaceId, id, tx);

      await helpers.recordTombstone(canonicalWorkspaceId, {
        entityType: 'Item',
        entityId: id,
      });

      await helpers.publishOutbox(
        canonicalWorkspaceId,
        id,
        'library.item.purged',
        {
          id,
          purgedAt: new Date(),
        },
      );

      await this.tagsService.invalidateTagsCache(canonicalWorkspaceId);

      return purged;
    });
  }

  async getRelatedItems(workspaceId: string, itemId: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const item = await this.query.findById(canonicalWorkspaceId, itemId);
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
    workspaceId: string,
    sourceItemId: string,
    data: { targetItemId: string; relationType?: string; note?: string },
  ) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const sourceItem = await this.query.findById(
      canonicalWorkspaceId,
      sourceItemId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    const targetItem = await this.query.findById(
      canonicalWorkspaceId,
      data.targetItemId,
    );
    if (!targetItem) {
      throw new NotFoundException(`Target item ${data.targetItemId} not found`);
    }

    const type = data.relationType ?? 'related';
    const now = new Date().toISOString();

    const relation = {
      id: randomUUID(),
      targetItemId: data.targetItemId,
      relationType: type,
      note: data.note,
      linkedAt: now,
    };

    await this.command.putRelation(sourceItemId, relation);

    return {
      success: true,
      link: relation,
      message: `Linked "${sourceItem.title}" to "${targetItem.title}"`,
    };
  }

  async unlinkItems(
    workspaceId: string,
    sourceItemId: string,
    targetItemId: string,
  ) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const sourceItem = await this.query.findById(
      canonicalWorkspaceId,
      sourceItemId,
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

  async getItemSnapshot(workspaceId: string, itemId: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.getItemSnapshot(canonicalWorkspaceId, itemId);
  }

  async getItemSnapshots(workspaceId: string, itemIds: string[]) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.getItemSnapshots(canonicalWorkspaceId, itemIds);
  }

  // ── Port Implementations (IItemExistencePort & IItemReadPort) ────────────

  async exists(workspaceId: string, itemId: string): Promise<boolean> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.exists(canonicalWorkspaceId, itemId);
  }

  async assertExists(workspaceId: string, itemId: string): Promise<void> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.assertExists(canonicalWorkspaceId, itemId);
  }

  async existMany(
    workspaceId: string,
    itemIds: string[],
  ): Promise<Map<string, boolean>> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.existMany(canonicalWorkspaceId, itemIds);
  }

  async findById(workspaceId: string, itemId: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.findById(canonicalWorkspaceId, itemId);
  }

  async findByIds(workspaceId: string, itemIds: string[]) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.findByIds(canonicalWorkspaceId, itemIds);
  }

  async findByDoi(workspaceId: string, doi: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.findByDoi(canonicalWorkspaceId, doi);
  }

  async findSummaryById(workspaceId: string, itemId: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.findSummaryById(canonicalWorkspaceId, itemId);
  }

  async findSummariesByIds(workspaceId: string, itemIds: string[]) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.findSummariesByIds(canonicalWorkspaceId, itemIds);
  }

  async findQualityAuditItems(workspaceId: string, limit?: number) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.findQualityAuditItems(canonicalWorkspaceId, limit);
  }

  async findDuplicateCandidateItems(workspaceId: string, limit?: number) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.query.findDuplicateCandidateItems(canonicalWorkspaceId, limit);
  }

  /**
   * Sync protocol adapter: transactional upsert for a Item from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncItemCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    if (command.existingId) {
      const existing = await tx.item.findUnique({
        where: { id: command.existingId },
        include: { itemTags: { include: { tag: true } } },
      });

      if (!existing) {
        throw new NotFoundException(
          `Item ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      if (existing.workspaceId !== command.workspaceId) {
        throw new ForbiddenException(
          `Item ${command.existingId} does not belong to workspace ${command.workspaceId}`,
        );
      }

      const existingTagNames = (existing.itemTags || []).map(
        (it) => it.tag.name,
      );
      const mergedTags = normalizeTags([
        ...existingTagNames,
        ...(command.tags || []),
      ]);

      const updated = await this.command.update(
        command.workspaceId,
        command.existingId,
        undefined,
        {
          ...command,
          tags: mergedTags,
          userId: command.userId,
        },
        tx,
      );

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Item',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: { title: command.title },
      });

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      const created = await this.command.create(
        command.workspaceId,
        {
          ...command,
          uploadedById: command.userId,
        },
        tx,
      );

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Item',
        entityId: created.id,
        action: 'create',
        version: 1,
        data: { title: command.title },
      });

      await helpers.publishOutbox(
        command.workspaceId,
        created.id,
        LIBRARY_EVENT_TYPES.ITEM_CREATED,
        buildItemCreatedOutboxPayload({
          itemId: created.id,
          workspaceId: command.workspaceId,
          title: created.title,
          source: 'external_sync',
        }),
      );

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  /**
   * Sync protocol adapter: transactional soft-delete for a Item from an external sync batch.
   */
  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const {
      workspaceId,
      entityId,
      reason,
      publishOutboxEventType,
      publishOutboxPayload,
    } = command;
    const existing = await tx.item.findUnique({
      where: { id: entityId },
    });
    if (!existing) return;

    if (existing.workspaceId !== workspaceId) {
      throw new ForbiddenException(
        `Item ${entityId} does not belong to workspace ${workspaceId}`,
      );
    }

    await tx.item.update({
      where: { id: entityId },
      data: { deletedAt: new Date() },
    });
    await helpers.appendChange(workspaceId, {
      entityType: 'Item',
      entityId,
      action: 'delete',
      version: existing.version + 1,
      data: { reason },
    });
    await helpers.recordTombstone(workspaceId, {
      entityType: 'Item',
      entityId,
    });
    await helpers.publishOutbox(
      workspaceId,
      entityId,
      publishOutboxEventType ?? 'library.item.deleted',
      publishOutboxPayload ?? { itemId: entityId, reason },
    );
  }

  /**
   * Generates a deterministic preview of item-type conversion without modifying DB state.
   */
  previewTypeConversion(
    rawItem: Record<string, any>,
    targetType: string,
    options: { retainUnmappedInExtra?: boolean } = {},
  ): TypeConversionPreview {
    return this.transformer.previewConversion(rawItem, targetType, options);
  }

  /**
   * Executes type conversion transactionally in the database.
   */
  async convertItemType(
    workspaceId: string,
    itemId: string,
    targetType: string,
    options: ConvertTypeOptions = {},
    tx?: Prisma.TransactionClient,
  ) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const rawExisting = await this.query.findById(
      canonicalWorkspaceId,
      itemId,
      tx,
    );
    if (!rawExisting) {
      throw new NotFoundException(
        `Item ${itemId} not found in workspace ${canonicalWorkspaceId}`,
      );
    }
    const existing = ItemsMapper.toDomain<ItemDetail>(rawExisting);

    const preview = this.previewTypeConversion(existing, targetType, {
      retainUnmappedInExtra: options.retainUnmappedInExtra ?? true,
    });

    const projected = preview.projectedItem;

    const targetFields = this.typesService.getOrderedFields(targetType);
    const dynamicExtraFields: Record<string, any> = {
      ...(projected.extraFields || {}),
    };

    for (const field of targetFields) {
      const val = this.transformer.getItemFieldValue(projected, field.key);
      if (
        val !== undefined &&
        val !== null &&
        val !== '' &&
        !ITEM_COLUMN_METADATA_FIELDS.has(field.key) &&
        !ITEM_COLUMN_METADATA_FIELDS.has(FIELD_ALIASES[field.key])
      ) {
        dynamicExtraFields[field.key] = val;
      }
    }

    const updatePayload: Record<string, any> = {
      itemType: targetType,
      type: targetType,
      creators: projected.creators ?? existing.creators,
      extraFields: dynamicExtraFields,
    };

    const droppedSet = new Set(
      preview.droppedFields.map((d) => d.field.toLowerCase()),
    );

    for (const col of ITEM_COLUMN_METADATA_FIELDS) {
      if (FIELD_ALIASES[col] && FIELD_ALIASES[col] !== col) continue;

      const colLower = col.toLowerCase();
      if (droppedSet.has(colLower)) {
        updatePayload[col] = '';
      } else {
        const val =
          this.transformer.getItemFieldValue(projected, col) ??
          (existing as unknown as Record<string, unknown>)[col];
        if (val !== undefined) {
          updatePayload[col] = val;
        }
      }
    }

    const updated = await this.command.update(
      canonicalWorkspaceId,
      itemId,
      options.expectedVersion,
      updatePayload,
      tx,
    );

    return {
      success: true,
      item: ItemsMapper.toDomain(updated),
      conversionReport: preview,
    };
  }
}
