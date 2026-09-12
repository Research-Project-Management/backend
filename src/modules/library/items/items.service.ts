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
import { CreateItemData, UpdateItemData } from './types/items.types';
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
} from '../sync/types/sync.types';

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

  private mapFlattenedState(
    item: Record<string, any>,
    userId?: string,
  ): Record<string, any> | null {
    return ItemsMapper.mapFlattenedState(item, userId);
  }

  async getItem(userId: string, id: string, projectId?: string) {
    const item = await this.query.findById(userId, id, projectId);
    if (!item) return null;
    return this.mapFlattenedState(item, userId);
  }

  async getFulltext(userId: string, id: string) {
    return this.query.getFulltext(userId, id);
  }

  async listItems(
    userId: string,
    options: {
      view?:
        | 'all'
        | 'recent'
        | 'unfiled'
        | 'trash'
        | 'my-publications'
        | 'publications';
      collectionId?: string;
      tagId?: string;
      search?: string;
      limit?: number;
      cursor?: string;
      projectId?: string;
    },
  ): Promise<CursorPaginatedResult<any>> {
    const limit = Math.min(options.limit ?? 50, 100);
    const queryOptions = { ...options, userId };
    const [totalCount, rawItems] = await Promise.all([
      this.query.count(userId, queryOptions),
      this.query.findMany(userId, {
        ...queryOptions,
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
      this.mapFlattenedState(it, userId),
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
    userId: string,
    data: CreateItemData,
    context?: Partial<ItemTransactionContext> & {
      source?: LibraryItemSource;
    },
  ): Promise<any> {
    const execute = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => {
      const item = await this.command.create(userId, data, tx);

      await helpers.appendChange(userId, {
        entityType: 'Item',
        entityId: item.id,
        action: 'create',
        version: item.version,
        data: item,
      });

      const payload = buildItemCreatedOutboxPayload({
        itemId: item.id,
        workspaceId: userId,
        title: item.title,
        source: context?.source ?? 'manual',
        doi: item.doi,
      });

      await helpers.publishOutbox(
        userId,
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
    userId: string,
    id: string,
    expectedVersion: number | undefined,
    data: UpdateItemData,
    context?: ItemTransactionContext,
  ): Promise<any> {
    if (context) {
      const updated = await this.command.update(
        userId,
        id,
        expectedVersion,
        data,
        context.tx,
      );

      await context.helpers.appendChange(userId, {
        entityType: 'Item',
        entityId: id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await context.helpers.publishOutbox(
        userId,
        id,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        updated,
      );

      return ItemsMapper.toDomain(updated);
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      return this.updateItem(userId, id, expectedVersion, data, {
        tx,
        helpers,
      });
    });
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

      await helpers.appendChange(userId, {
        entityType: 'Item',
        entityId: id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await helpers.publishOutbox(
        userId,
        id,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        updated,
      );

      return ItemsMapper.toDomain(updated);
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

  async reindexItem(userId: string, id: string) {
    const item = await this.query.findById(userId, id);
    if (!item) {
      throw new NotFoundException(
        `Item ${id} not found in user library`,
      );
    }

    await this.libraryTx.executeInTransaction(async (_tx, helpers) => {
      await helpers.publishOutbox(
        userId,
        id,
        'library.item.reindexed',
        {
          itemId: id,
          workspaceId: userId,
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
    userId: string,
    id: string,
    expectedVersion?: number,
    context?: ItemTransactionContext,
  ): Promise<boolean> {
    if (context) {
      const deleted = await this.command.softDelete(
        userId,
        id,
        expectedVersion,
        context.tx,
      );

      if (deleted) {
        await context.helpers.recordTombstone(userId, {
          entityType: 'Item',
          entityId: id,
        });

        await context.helpers.publishOutbox(
          userId,
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
        userId,
        id,
        expectedVersion,
        {
          tx,
          helpers,
        },
      );
      await this.tagsService.invalidateTagsCache(userId);
      return deleted;
    });
  }

  async restoreItem(userId: string, id: string, expectedVersion?: number) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const restored = await this.command.restore(
        userId,
        id,
        expectedVersion,
        tx,
      );

      await helpers.appendChange(userId, {
        entityType: 'Item',
        entityId: id,
        action: 'update',
        version: restored.version,
        data: restored,
      });

      await helpers.publishOutbox(
        userId,
        id,
        'library.item.restored',
        {
          id,
          restoredAt: new Date(),
        },
      );

      await this.tagsService.invalidateTagsCache(userId);

      return ItemsMapper.toDomain(restored);
    });
  }

  async purgeItem(userId: string, id: string): Promise<boolean> {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const purged = await this.command.purge(userId, id, tx);

      await helpers.recordTombstone(userId, {
        entityType: 'Item',
        entityId: id,
      });

      await helpers.publishOutbox(
        userId,
        id,
        'library.item.purged',
        {
          id,
          purgedAt: new Date(),
        },
      );

      await this.tagsService.invalidateTagsCache(userId);

      return purged;
    });
  }

  async getRelatedItems(userId: string, itemId: string) {
    const item = await this.query.findById(userId, itemId);
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
    data: { targetItemId: string; relationType?: string; note?: string },
  ) {
    const sourceItem = await this.query.findById(
      userId,
      sourceItemId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    const targetItem = await this.query.findById(
      userId,
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
    userId: string,
    sourceItemId: string,
    targetItemId: string,
  ) {
    const sourceItem = await this.query.findById(
      userId,
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

  async getItemSnapshot(userId: string, itemId: string) {
    return this.query.getItemSnapshot(userId, itemId);
  }

  async getItemSnapshots(userId: string, itemIds: string[]) {
    return this.query.getItemSnapshots(userId, itemIds);
  }

  // ── Port Implementations (IItemExistencePort & IItemReadPort) ────────────

  async exists(userId: string, itemId: string): Promise<boolean> {
    return this.query.exists(userId, itemId);
  }

  async assertExists(userId: string, itemId: string): Promise<void> {
    return this.query.assertExists(userId, itemId);
  }

  async existMany(
    userId: string,
    itemIds: string[],
  ): Promise<Map<string, boolean>> {
    return this.query.existMany(userId, itemIds);
  }

  async findById(userId: string, itemId: string) {
    return this.query.findById(userId, itemId);
  }

  async findByIds(userId: string, itemIds: string[]) {
    return this.query.findByIds(userId, itemIds);
  }

  async findByDoi(userId: string, doi: string) {
    return this.query.findByDoi(userId, doi);
  }

  async findSummaryById(userId: string, itemId: string) {
    return this.query.findSummaryById(userId, itemId);
  }

  async findSummariesByIds(userId: string, itemIds: string[]) {
    return this.query.findSummariesByIds(userId, itemIds);
  }

  async findQualityAuditItems(userId: string, limit?: number) {
    return this.query.findQualityAuditItems(userId, limit);
  }

  async findDuplicateCandidateItems(userId: string, limit?: number) {
    return this.query.findDuplicateCandidateItems(userId, limit);
  }

  /**
   * Sync protocol adapter: transactional upsert for a Item from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncItemCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    const userId = command.userId;
    if (command.existingId) {
      const existing = await tx.item.findUnique({
        where: { id: command.existingId },
        include: { itemTags: { include: { tag: true } } },
      });

      if (!existing) {
        throw new NotFoundException(
          `Item ${command.existingId} not found`,
        );
      }

      if (existing.userId && existing.userId !== userId) {
        throw new ForbiddenException(
          `Item ${command.existingId} does not belong to user ${userId}`,
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
        userId,
        command.existingId,
        undefined,
        {
          ...command,
          tags: mergedTags,
          userId: command.userId,
        },
        tx,
      );

      await helpers.appendChange(userId, {
        entityType: 'Item',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: { title: command.title },
      });

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      const created = await this.command.create(
        userId,
        {
          ...command,
          uploadedById: command.userId,
        },
        tx,
      );

      await helpers.appendChange(userId, {
        entityType: 'Item',
        entityId: created.id,
        action: 'create',
        version: 1,
        data: { title: command.title },
      });

      await helpers.publishOutbox(
        userId,
        created.id,
        LIBRARY_EVENT_TYPES.ITEM_CREATED,
        buildItemCreatedOutboxPayload({
          itemId: created.id,
          workspaceId: userId,
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
    const targetUserId =
      command.userId || (command as any).projectId || (command as any).workspaceId || '';
    const {
      entityId,
      reason,
      publishOutboxEventType,
      publishOutboxPayload,
    } = command;
    const existing = await tx.item.findUnique({
      where: { id: entityId },
    });
    if (!existing) return;

    if (
      targetUserId &&
      existing.userId &&
      existing.userId !== targetUserId
    ) {
      throw new ForbiddenException(
        `Item ${entityId} does not belong to user ${targetUserId}`,
      );
    }

    await tx.item.update({
      where: { id: entityId },
      data: { deletedAt: new Date() },
    });
    await helpers.appendChange(targetUserId, {
      entityType: 'Item',
      entityId,
      action: 'delete',
      version: existing.version + 1,
      data: { reason },
    });
    await helpers.recordTombstone(targetUserId, {
      entityType: 'Item',
      entityId,
    });
    await helpers.publishOutbox(
      targetUserId,
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
    userId: string,
    itemId: string,
    targetType: string,
    options: ConvertTypeOptions = {},
    tx?: Prisma.TransactionClient,
  ) {
    const rawExisting = await this.query.findById(
      userId,
      itemId,
      undefined,
      tx,
    );
    if (!rawExisting) {
      throw new NotFoundException(
        `Item ${itemId} not found in user library`,
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
      userId,
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

  async importItemsToProject(
    userId: string,
    projectId: string,
    itemIds: string[],
  ): Promise<{ success: boolean; importedCount: number }> {
    if (!itemIds || itemIds.length === 0) {
      return { success: true, importedCount: 0 };
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { members: true },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const isMember =
      project.createdById === userId ||
      project.members.some((m: any) => m.userId === userId);

    if (!isMember) {
      throw new ForbiddenException(
        'You do not have permission to import items to this project',
      );
    }

    const sourceItems = await this.query.findByIds(userId, itemIds);
    let importedCount = 0;

    for (const source of sourceItems) {
      const existingInProject = await this.prisma.item.findFirst({
        where: {
          projectId,
          deletedAt: null,
          OR: [
            ...(source.doi ? [{ doi: source.doi }] : []),
            ...(source.citationKey ? [{ citationKey: source.citationKey }] : []),
            { title: source.title },
          ],
        },
      });

      if (existingInProject) {
        continue;
      }

      await this.prisma.item.create({
        data: {
          projectId,
          userId: project.createdById,
          uploadedById: userId,
          title: source.title,
          year: source.year,
          doi: source.doi,
          abstract: source.abstract,
          itemType: source.itemType || 'journalArticle',
          publicationTitle: source.publicationTitle,
          publicationDate: source.publicationDate,
          publisher: source.publisher,
          place: source.place,
          volume: source.volume,
          issue: source.issue,
          section: source.section,
          partNumber: source.partNumber,
          partTitle: source.partTitle,
          pages: source.pages,
          series: source.series,
          seriesTitle: source.seriesTitle,
          seriesText: source.seriesText,
          issn: source.issn,
          isbn: source.isbn,
          pmid: source.pmid,
          pmcid: source.pmcid,
          url: source.url,
          language: source.language,
          journalAbbr: source.journalAbbr,
          shortTitle: source.shortTitle,
          rights: source.rights,
          license: source.license,
          citationKey: source.citationKey,
          libraryCatalog: source.libraryCatalog,
          archive: source.archive,
          archiveLocation: source.archiveLocation,
          callNumber: source.callNumber,
          extra: source.extra,
          version: 1,
          contributors:
            source.contributors && source.contributors.length > 0
              ? {
                  create: source.contributors.map((c: any) => ({
                    creatorType: c.creatorType || 'author',
                    firstName: c.firstName || '',
                    lastName: c.lastName || '',
                    fullName: c.fullName || '',
                    orderIndex: c.orderIndex ?? 0,
                  })),
                }
              : undefined,
          identifiers:
            source.identifiers && source.identifiers.length > 0
              ? {
                  create: source.identifiers.map((i: any) => ({
                    type: i.type,
                    value: i.value,
                    canonicalUri: i.canonicalUri,
                  })),
                }
              : undefined,
          attachments:
            source.attachments && source.attachments.length > 0
              ? {
                  create: source.attachments.map((a: any) => ({
                    fileId: a.fileId,
                    filename: a.filename,
                    mimeType: a.mimeType,
                    size: a.size,
                    attachmentType: a.attachmentType,
                    url: a.url,
                    storageKey: a.storageKey,
                  })),
                }
              : undefined,
        },
      });

      importedCount++;
    }

    return { success: true, importedCount };
  }
}
