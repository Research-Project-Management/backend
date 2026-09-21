import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
  Optional,
} from '@nestjs/common';
import { Prisma, RagStatus } from '@prisma/client';
import { QueryRepository } from '../../infrastructure/repositories/query.repository';
import { CommandRepository } from '../../infrastructure/repositories/command.repository';
import { CreateItemData, UpdateItemData } from '../../domain/types/items.types';
import { sanitizeItemTitle } from '../../../shared-kernel/utils/bibliographic.utils';
import {
  TransactionService,
  TransactionHelpers,
} from '../../../shared-kernel/outbox/transaction.service';
import {
  LIBRARY_EVENT_TYPES,
  SYNC_EVENT_TYPES,
  LibraryItemSource,
  buildItemCreatedOutboxPayload,
} from '../../../shared-kernel/outbox/outbox.events';
import {
  CursorPaginatedResult,
  DocumentFulltextResponse,
} from '../dtos/items.dto';
import { normalizeTags } from '../../../shared-kernel/utils/tag.utils';
import { TagsService } from './tags.service';
import { TypesService } from './types.service';
import { ItemSyncDelegate } from './item-sync.delegate';
import { ZoteroSchemaValidatorService } from './zotero-schema-validator.service';
import { ItemsMapper } from '../../infrastructure/mappers/items.mapper';
import {
  TypeConversionPreview,
  ConvertTypeOptions,
} from '../../domain/types/items.types';
import { ItemTransformer } from '../../infrastructure/mappers/item.transformer';
import {
  GrobidClient,
  GrobidReference,
} from '../../../shared-kernel/infra/grobid/grobid.client';
import { randomUUID } from 'crypto';
import {
  IItemReadPort,
  IItemExistencePort,
  ItemDetail,
  QualityAuditCandidateItem,
  DuplicateCandidateItem,
} from '../../domain/ports/items.ports';

import type {
  UpsertSyncItemCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../../../shared-kernel/core/types/entity-commands.types';

/** Transaction context passed to write methods for composing operations within a parent transaction. */
export interface ItemTransactionContext {
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
}

import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
} from '../../domain/constants/items.constants';

@Injectable()
export class ItemsService implements IItemReadPort, IItemExistencePort {
  private readonly logger = new Logger(ItemsService.name);

  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    private readonly libraryTx: TransactionService,
    private readonly tagsService: TagsService,
    private readonly typesService: TypesService,
    private readonly transformer: ItemTransformer,
    @Optional() private readonly rag?: any,
    @Optional() private readonly validator?: ZoteroSchemaValidatorService,
    @Optional() private readonly grobid?: GrobidClient,
    @Optional() private readonly semanticSearch?: any,
    @Optional() private readonly syncDelegate?: ItemSyncDelegate,
  ) {}

  /**
   * Parses raw unformatted citation strings or multi-line bibliographies via GROBID CRF.
   */
  async parseCitations(rawCitations: string): Promise<GrobidReference[]> {
    if (!this.grobid) {
      return [];
    }
    return this.grobid.processCitationList(rawCitations);
  }

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

  /**
   * Retrieves the structured academic full-text document tree extracted by GROBID.
   * Feeds the Frontend Reader's DocumentNavDrawer (Outline, Figures, Tables, Formulas).
   */
  async getFulltext(
    userId: string,
    id: string,
    projectId?: string,
  ): Promise<DocumentFulltextResponse> {
    const item = await this.query.findById(userId, id, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found or access denied`);
    }

    // 1. Look for authoritative grobid_fulltext record in metadataSourceRecord via QueryRepository
    const fulltextRecord = await this.query.findMetadataSourceRecord(
      id,
      'grobid_fulltext',
    );

    if (
      fulltextRecord?.rawPayload &&
      typeof fulltextRecord.rawPayload === 'object'
    ) {
      const payload = fulltextRecord.rawPayload as Record<string, any>;
      return {
        title: payload.title || item.title,
        abstract: payload.abstract || item.abstract || undefined,
        sections: Array.isArray(payload.sections) ? payload.sections : [],
        figures: Array.isArray(payload.figures) ? payload.figures : [],
        tables: Array.isArray(payload.tables) ? payload.tables : [],
        formulas: Array.isArray(payload.formulas) ? payload.formulas : [],
        references: Array.isArray(payload.references) ? payload.references : [],
      };
    }

    // 2. Fallback to grobid header record if available via QueryRepository
    const headerRecord = await this.query.findMetadataSourceRecord(
      id,
      'grobid',
    );

    if (
      headerRecord?.rawPayload &&
      typeof headerRecord.rawPayload === 'object'
    ) {
      const payload = headerRecord.rawPayload as Record<string, any>;
      return {
        title: payload.title || item.title,
        abstract: payload.abstract || item.abstract || undefined,
        sections: [],
        figures: [],
        tables: [],
        formulas: [],
        references: Array.isArray(payload.references) ? payload.references : [],
      };
    }

    // 3. Return clean empty structure instead of 404 so Reader renders gracefully
    return {
      title: item.title,
      abstract: item.abstract || undefined,
      sections: [],
      figures: [],
      tables: [],
      formulas: [],
      references: [],
    };
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
        limit: limit + 1,
      }),
    ]);

    let hasNextPage = false;
    let nextCursor: string | undefined;

    if (rawItems.length > limit) {
      hasNextPage = true;
      rawItems.pop();
      nextCursor = rawItems[rawItems.length - 1]?.id;
    }

    const items = rawItems
      .slice(0, limit)
      .map((it) => this.mapFlattenedState(it, userId));

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
      projectId?: string;
    },
    projectId?: string,
  ): Promise<any> {
    const cleanTitle = sanitizeItemTitle(data.title);
    if (!cleanTitle) {
      throw new UnprocessableEntityException('Item title cannot be empty');
    }
    data.title = cleanTitle;

    let itemPayload = data;
    if (this.validator) {
      const valRes = this.validator.validateAndSanitizeItem(
        data.itemType,
        data,
      );
      itemPayload = valRes.sanitizedItem as CreateItemData;
    } else if (
      data.itemType &&
      typeof this.typesService?.isValidItemType === 'function' &&
      !this.typesService.isValidItemType(data.itemType)
    ) {
      throw new BadRequestException(`Invalid itemType: ${data.itemType}`);
    }

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

    let updatePayload = data;
    if (this.validator && (data.itemType || data.creators)) {
      const valRes = this.validator.validateAndSanitizeItem(
        data.itemType,
        data,
      );
      updatePayload = valRes.sanitizedItem as UpdateItemData;
    } else if (
      data.itemType &&
      typeof this.typesService?.isValidItemType === 'function' &&
      !this.typesService.isValidItemType(data.itemType)
    ) {
      throw new BadRequestException(`Invalid itemType: ${data.itemType}`);
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

      return ItemsMapper.toDomain(updated);
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
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

      return ItemsMapper.toDomain(updated);
    });
  }

  private async executePaperRagIndexing(item: any): Promise<void> {
    await this.command.updateRagStatus(item.id, {
      ragStatus: RagStatus.pending,
      ragLastAttemptAt: new Date(),
    });

    let localIndexed = false;
    // 1. In-process Local Semantic Vector Indexing (100% offline, Zero-API)
    try {
      if (this.semanticSearch) {
        await this.semanticSearch.indexItem(item);
        localIndexed = true;
      }
    } catch (err: any) {
      this.logger.debug(`Local semantic indexing skipped: ${err?.message}`);
    }

    // 2. External Qdrant indexing if FLUX_AI_URL is available
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
      const message =
        err instanceof Error ? err.message : 'External RAG unavailable';
      if (localIndexed) {
        // Local in-process vector search is ready, so mark as indexed!
        await this.command.updateRagStatus(item.id, {
          ragStatus: 'indexed',
          ragIndexedAt: new Date(),
        });
        this.logger.log(
          `Paper ${item.id} indexed into local vector store (external Qdrant offline).`,
        );
      } else {
        await this.command.updateRagStatus(item.id, {
          ragStatus: 'failed',
          ragError: message,
        });
        this.logger.error(`Failed to index paper ${item.id}: ${message}`);
      }
    }
  }

  async reindexItem(userId: string, id: string, projectId?: string) {
    const item = await this.query.findById(userId, id, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in user library`);
    }

    const effectiveProjectId =
      projectId ?? (item as any).projectId ?? undefined;
    const eventScope = { userId, projectId: effectiveProjectId };

    await this.libraryTx.executeInTransaction(async (_tx, helpers) => {
      await helpers.publishOutbox(eventScope, id, 'library.item.reindexed', {
        itemId: id,
        userId,
        projectId: effectiveProjectId,
      });
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
    return result;
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

    for (const targetId of targetIds) {
      const targetItem = await this.query.findById(userId, targetId, projectId);
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

  async getItemSnapshot(userId: string, itemId: string) {
    return this.query.getItemSnapshot(userId, itemId);
  }

  async getItemSnapshots(userId: string, itemIds: string[]) {
    return this.query.getItemSnapshots(userId, itemIds);
  }

  // ── Port Implementations (IItemExistencePort & IItemReadPort) ────────────

  async exists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    return this.query.exists(userId, itemId, undefined, projectId);
  }

  async assertExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    return this.query.assertExists(userId, itemId, undefined, projectId);
  }

  async existMany(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<Map<string, boolean>> {
    return this.query.existMany(userId, itemIds, undefined, projectId);
  }

  async findById(userId: string, itemId: string, projectId?: string) {
    return this.query.findById(userId, itemId, projectId);
  }

  async findByIds(userId: string, itemIds: string[], projectId?: string) {
    return this.query.findByIds(userId, itemIds, projectId);
  }

  async findByDoi(userId: string, doi: string, projectId?: string) {
    return this.query.findByDoi(userId, doi, projectId);
  }

  async findSummaryById(userId: string, itemId: string, projectId?: string) {
    return this.query.findSummaryById(userId, itemId, undefined, projectId);
  }

  async findSummariesByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ) {
    return this.query.findSummariesByIds(userId, itemIds);
  }

  async findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<QualityAuditCandidateItem[]> {
    return this.query.findQualityAuditItems(userId, limit) as unknown as QualityAuditCandidateItem[];
  }

  async findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<DuplicateCandidateItem[]> {
    return this.query.findDuplicateCandidateItems(userId, limit) as unknown as DuplicateCandidateItem[];
  }

  /**
   * Sync protocol adapter: transactional upsert for a Item from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncItemCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    const delegate = this.syncDelegate ?? new ItemSyncDelegate(this.command);
    return delegate.upsertFromSync(command, tx, helpers);
  }

  /**
   * Sync protocol adapter: transactional soft-delete for a Item from an external sync batch.
   */
  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const delegate = this.syncDelegate ?? new ItemSyncDelegate(this.command);
    return delegate.deleteFromSync(command, tx, helpers);
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
      throw new NotFoundException(`Item ${itemId} not found in user library`);
    }
    const existing = ItemsMapper.toDomain<ItemDetail>(rawExisting);

    const preview = this.previewTypeConversion(existing, targetType, {
      retainUnmappedInExtra: options.retainUnmappedInExtra ?? true,
    });

    const targetFields = this.typesService.getOrderedFields(targetType);
    const updatePayload = buildTypeConversionUpdatePayload(
      targetType,
      existing,
      preview,
      targetFields,
      this.transformer,
    );

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

    const project = await this.query.findProjectWithMembers(projectId);

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
      const existingInProject = await this.query.findDuplicateInProject(
        projectId,
        {
          doi: source.doi,
          citationKey: source.citationKey,
          title: source.title,
        },
      );

      if (existingInProject) {
        continue;
      }

      const createData = buildImportItemPayload(source, userId);
      await this.createItem(
        userId,
        createData,
        { projectId, source: 'external_sync' },
        projectId,
      );

      importedCount++;
    }

    return { success: true, importedCount };
  }
}

export function buildImportItemPayload(
  source: any,
  userId: string,
): CreateItemData {
  const primaryAttachment = source.attachments?.[0];
  const resolvedFileId = primaryAttachment?.fileId
    ? String(primaryAttachment.fileId)
    : (source as any).fileId
      ? String((source as any).fileId)
      : undefined;
  const resolvedFileUrl =
    primaryAttachment?.url || (source as any).fileUrl || undefined;
  const resolvedFilename =
    primaryAttachment?.filename ||
    primaryAttachment?.name ||
    (source as any).filename ||
    undefined;
  const resolvedMimeType =
    primaryAttachment?.mimeType || (source as any).mimeType || undefined;
  const resolvedSize =
    primaryAttachment?.size || (source as any).size || undefined;
  const resolvedFileHash =
    primaryAttachment?.fileHash || (source as any).fileHash || undefined;

  return {
    title: source.title,
    uploadedById: userId,
    year: source.year ?? undefined,
    doi: source.doi ?? undefined,
    abstract: source.abstract ?? undefined,
    itemType: source.itemType || 'journalArticle',
    publicationTitle: source.publicationTitle ?? undefined,
    publicationDate: source.publicationDate ?? undefined,
    publisher: source.publisher ?? undefined,
    place: source.place ?? undefined,
    volume: source.volume ?? undefined,
    issue: source.issue ?? undefined,
    section: source.section ?? undefined,
    partNumber: source.partNumber ?? undefined,
    partTitle: source.partTitle ?? undefined,
    pages: source.pages ?? undefined,
    series: source.series ?? undefined,
    seriesTitle: source.seriesTitle ?? undefined,
    seriesText: source.seriesText ?? undefined,
    issn: source.issn ?? undefined,
    isbn: source.isbn ?? undefined,
    pmid: source.pmid ?? undefined,
    pmcid: source.pmcid ?? undefined,
    url: source.url ?? undefined,
    language: source.language ?? undefined,
    journalAbbr: source.journalAbbr ?? undefined,
    shortTitle: source.shortTitle ?? undefined,
    rights: source.rights ?? undefined,
    license: source.license ?? undefined,
    citationKey: source.citationKey ?? undefined,
    libraryCatalog: source.libraryCatalog ?? undefined,
    archive: source.archive ?? undefined,
    archiveLocation: source.archiveLocation ?? undefined,
    callNumber: source.callNumber ?? undefined,
    extra: source.extra ?? undefined,
    arxivId: source.arxivId ?? undefined,
    citationCount: source.citationCount ?? undefined,
    referenceCount: source.referenceCount ?? undefined,
    openAccessPdfUrl: source.openAccessPdfUrl ?? undefined,
    fileId: resolvedFileId,
    fileUrl: resolvedFileUrl,
    filename: resolvedFilename,
    mimeType: resolvedMimeType,
    size: resolvedSize,
    fileHash: resolvedFileHash,
    tags:
      source.itemTags?.map((it: any) => it.tag?.name).filter(Boolean) || [],
    notes:
      source.notesList?.map((n: any) => ({
        title: n.title,
        contentMd: n.contentMd,
        content: n.contentMd,
        tags: n.tags || [],
      })) || [],
    creators: source.contributors?.map((c: any) => ({
      creatorType: c.creatorType || 'author',
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      fullName: c.fullName || '',
      name: c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      orderIndex: c.orderIndex ?? 0,
    })),
    identifiers: source.identifiers?.map((i: any) => ({
      type: i.type,
      value: i.value,
      canonicalUri: i.canonicalUri,
    })),
  };
}

export function buildTypeConversionUpdatePayload(
  targetType: string,
  existing: any,
  preview: TypeConversionPreview,
  targetFields: any[],
  transformer: ItemTransformer,
): Record<string, any> {
  const projected = preview.projectedItem;
  const dynamicExtraFields: Record<string, any> = {
    ...(projected.extraFields || {}),
  };

  for (const field of targetFields) {
    const val = transformer.getItemFieldValue(projected, field.key);
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
      updatePayload[col] = null;
    } else {
      const val =
        transformer.getItemFieldValue(projected, col) ??
        (existing as unknown as Record<string, unknown>)[col];
      if (val !== undefined) {
        updatePayload[col] = val;
      }
    }
  }

  return updatePayload;
}

