import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LibraryItemSource,
  CATALOG_FACADE,
  CATALOG_READER_PORT,
  CATALOG_WRITER_PORT,
  CATALOG_COLLECTION_PORT,
  CATALOG_TRASH_PORT,
  CATALOG_IMPORT_EXPORT_PORT,
  ICatalogFacade,
  ICatalogReaderPort,
  ICatalogWriterPort,
  ICatalogCollectionPort,
  ICatalogTrashPort,
  ICatalogImportExportPort,
  CatalogItemSummary,
  ItemsMapper,
} from '@/modules/library/core';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { ItemCurationService } from '@/modules/library/catalog/services/curation.service';
import { CollectionsService } from '@/modules/library/catalog/services/collections.service';
import { TagsService } from '@/modules/library/catalog/services/tags.service';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { ItemCacheCoordinator } from '@/modules/library/catalog/services/item-cache.service';
import { StateService } from '@/modules/library/catalog/services/state.service';
import { NotesService } from '@/modules/library/catalog/services/notes.service';
import {
  ItemDetail,
  DuplicateCandidateItem,
  QualityAuditCandidateItem,
  CreateItemData,
  UpdateItemData,
} from '@/modules/library/core/types/bibliographic.types';
import {
  NoteEntity,
  CreateNoteData,
} from '@/modules/library/catalog/types/catalog.types';
import { ItemFieldDefinition } from '@/modules/library/core/types/schema.types';

export {
  CATALOG_FACADE,
  CATALOG_READER_PORT,
  CATALOG_WRITER_PORT,
  CATALOG_COLLECTION_PORT,
  CATALOG_TRASH_PORT,
  CATALOG_IMPORT_EXPORT_PORT,
  ItemsMapper,
};
export type {
  ICatalogFacade,
  ICatalogReaderPort,
  ICatalogWriterPort,
  ICatalogCollectionPort,
  ICatalogTrashPort,
  ICatalogImportExportPort,
  CatalogItemSummary,
};

/**
 * Public Facade for Catalog Bounded Context.
 * Implements role-segregated Catalog ports (`ICatalogReaderPort`, `ICatalogWriterPort`,
 * `ICatalogCollectionPort`, `ICatalogTrashPort`, `ICatalogImportExportPort`).
 */
@Injectable()
export class CatalogFacade implements ICatalogFacade {
  constructor(
    private readonly queryService: ItemQueryService,
    private readonly itemService: ItemService,
    private readonly collectionsService: CollectionsService,
    private readonly tagsService: TagsService,
    private readonly typesService: TypesService,
    private readonly stateService: StateService,
    private readonly notesService: NotesService,
    @Optional()
    private readonly curationService?: ItemCurationService,
    @Optional()
    private readonly cacheCoordinator?: ItemCacheCoordinator,
  ) {}

  // ===========================================================================
  // 1. ICatalogReaderPort
  // ===========================================================================

  async getItem<T = ItemDetail>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null> {
    if (typeof this.queryService.getItem === 'function') {
      return (await this.queryService.getItem(
        userId,
        itemId,
        projectId,
      )) as unknown as T | null;
    }
    const raw = await this.queryService.findById(userId, itemId, projectId);
    return raw
      ? (ItemsMapper.mapFlattenedState(raw, userId) as unknown as T)
      : null;
  }

  async getItemSummary<T = CatalogItemSummary>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null> {
    return (await this.queryService.findSummaryById(
      userId,
      itemId,
      projectId,
    )) as T | null;
  }

  async itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    return this.queryService.exists(userId, itemId, projectId);
  }

  async getTags<T = unknown>(
    userId: string,
    options?: { includeInactive?: boolean; projectId?: string },
  ): Promise<T[]> {
    return (await this.tagsService.getTags(userId, options)) as unknown as T[];
  }

  async getItemState<T = unknown>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null> {
    return (await this.stateService.getState(
      userId,
      itemId,
      projectId,
    )) as unknown as T | null;
  }

  async findByIds<T = ItemDetail>(
    userId: string,
    itemIds: string[],
    projectId?: string,
    options?: { includeContent?: boolean },
  ): Promise<T[]> {
    const raw =
      options?.includeContent !== undefined
        ? await this.queryService.findByIds(userId, itemIds, projectId, options)
        : await this.queryService.findByIds(userId, itemIds, projectId);
    return ItemsMapper.toDomainList(raw, userId) as unknown as T[];
  }

  async getItemsByIds<T = ItemDetail>(
    userId: string,
    itemIds: string[],
    projectId?: string,
    options?: { includeContent?: boolean },
  ): Promise<T[]> {
    return this.findByIds<T>(userId, itemIds, projectId, options);
  }

  async countItems(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<number> {
    return this.queryService.count(userId, options || { view: 'all' });
  }

  async findMany<T = ItemDetail>(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<T[]> {
    return (await this.queryService.findMany(
      userId,
      options || {},
    )) as unknown as T[];
  }

  async listItems<T = ItemDetail>(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<{ items: T[]; meta?: Record<string, unknown> } | T[]> {
    return (await this.queryService.listItems(
      userId,
      options || {},
    )) as unknown as { items: T[]; meta?: Record<string, unknown> };
  }

  async validateItemType(type: string): Promise<boolean> {
    return this.typesService.isValidItemType(type);
  }

  getPrimaryCreatorType(itemType: string): string {
    return this.typesService.getPrimaryCreatorType(itemType);
  }

  getOrderedFields(itemType: string): ItemFieldDefinition[] {
    return this.typesService.getOrderedFields(itemType);
  }

  async findQualityAuditItems<T = QualityAuditCandidateItem>(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<T[]> {
    return (await this.queryService.findQualityAuditItems(
      userId,
      limit,
      projectId,
    )) as unknown as T[];
  }

  async findDuplicateCandidateItems<T = DuplicateCandidateItem>(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<T[]> {
    return (await this.queryService.findDuplicateCandidateItems(
      userId,
      limit,
      projectId,
    )) as unknown as T[];
  }

  async listNotes(
    userId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<NoteEntity[]> {
    return this.notesService.listNotes(userId, itemId, projectId);
  }

  async findMatchCandidates(
    scope: { userId?: string; projectId?: string | null },
    criteria: {
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      year?: number | null;
      titleWords?: string[];
      titlePrefix?: string;
    },
  ) {
    return this.queryService.findMatchCandidates(scope, criteria);
  }

  async findAttachmentByFileId(
    fileId: string,
    scope?: { userId?: string; projectId?: string },
  ): Promise<{ id: string; itemId: string; metadata?: unknown } | null> {
    if (!this.curationService) return null;
    return this.curationService.findAttachmentByFileId(fileId, scope);
  }

  // ===========================================================================
  // 2. ICatalogWriterPort
  // ===========================================================================

  async createItem<T = ItemDetail, D = CreateItemData>(
    userId: string,
    data: D,
    options?: {
      expectedVersion?: number;
      suppressIndexing?: boolean;
      projectId?: string;
      source?: LibraryItemSource;
      idempotencyKey?: string;
      correlationId?: string;
    },
    projectId?: string,
  ): Promise<T> {
    return (await this.itemService.createItem(
      userId,
      data as CreateItemData,
      options,
      projectId,
    )) as unknown as T;
  }

  async updateItem<T = ItemDetail, D = UpdateItemData>(
    userId: string,
    itemId: string,
    data: D,
    options?: { expectedVersion?: number; projectId?: string },
  ): Promise<T> {
    return (await this.itemService.updateItem(
      userId,
      itemId,
      options?.expectedVersion,
      data as UpdateItemData,
      undefined,
      options?.projectId,
    )) as unknown as T;
  }

  async deleteItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    await this.itemService.deleteItem(
      userId,
      itemId,
      undefined,
      undefined,
      projectId,
    );
  }

  async bulkDeleteItems(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<unknown> {
    return this.itemService.bulkTrash(userId, itemIds, projectId);
  }

  async mergeItems(
    tx: Prisma.TransactionClient,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<void> {
    await Promise.all([
      this.tagsService.mergeTagsToItem(tx, duplicateItemIds, primaryItemId),
      this.collectionsService.transferItemMemberships(
        duplicateItemIds,
        primaryItemId,
        tx,
      ),
      this.stateService.transferUserItemStates(
        tx,
        duplicateItemIds,
        primaryItemId,
      ),
      this.notesService
        ? this.notesService.reassignToItem(duplicateItemIds, primaryItemId, tx)
        : Promise.resolve(),
    ]);
  }

  async createNote(userId: string, data: CreateNoteData): Promise<NoteEntity> {
    return this.notesService.createNote(userId, data);
  }

  async updateAttachmentProcessingStatus(
    attachmentId: string,
    status: string,
    metadataPatch?: Record<string, unknown>,
    scope?: { userId?: string; projectId?: string },
  ): Promise<void> {
    if (!this.curationService) return;
    await this.curationService.updateAttachmentProcessingStatus(
      attachmentId,
      status,
      metadataPatch,
      scope,
    );
  }

  async updateItemAiMetadata(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
    scope?: { userId?: string; projectId?: string },
  ): Promise<void> {
    if (!this.curationService) return;
    await this.curationService.updateItemAiMetadata(
      itemId,
      aiMetadataPatch,
      scope,
    );
  }

  async invalidateForWrite(params: {
    userId: string;
    projectId?: string | null;
    itemIds?: string[];
    additionalProjectIds?: Array<string | null | undefined>;
    skipScopeInvalidation?: boolean;
    onlyUserStateOverlay?: boolean;
    preserveContentCaches?: boolean;
  }): Promise<void> {
    if (!this.cacheCoordinator) return;
    await this.cacheCoordinator.invalidateForWrite(params);
  }

  // ===========================================================================
  // 3. ICatalogCollectionPort
  // ===========================================================================

  async listCollections(
    userId: string,
    projectId?: string,
  ): Promise<
    Awaited<ReturnType<CollectionsService['getCollections']>>['collections']
  > {
    const res = await this.collectionsService.getCollections(userId, projectId);
    return res.collections;
  }

  async getCollections(userId: string, projectId?: string): Promise<unknown> {
    return this.collectionsService.getCollections(userId, projectId);
  }

  async assignItemsToCollection(
    userId: string,
    collectionId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<unknown> {
    return this.collectionsService.assignItemsToCollection(
      userId,
      collectionId,
      { itemIds },
      projectId,
    );
  }

  // ===========================================================================
  // 4. ICatalogTrashPort
  // ===========================================================================

  async restoreItems(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<unknown> {
    return this.itemService.bulkRestore(userId, itemIds, projectId);
  }

  async emptyTrash(userId: string, projectId?: string): Promise<unknown> {
    return this.itemService.emptyTrash(userId, projectId);
  }

  async purgeOldTrash(
    retentionDays?: number,
    limit?: number,
  ): Promise<unknown> {
    return this.itemService.purgeExpiredTrash(retentionDays, limit);
  }
}

export type { DuplicateCandidateItem };
