import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ItemService } from './services/items.service';
import { ItemQueryService } from './services/item-query.service';
import { ItemCurationService } from './services/item-curation.service';
import { ItemCacheCoordinator } from './services/item-cache.coordinator';
import { CollectionsService } from './services/collections.service';
import { TagsService } from './services/tags.service';
import { TypesService } from './services/types.service';
import { StateService } from './services/state.service';
import { NotesService } from './services/notes.service';
import {
  ItemDetail,
  DuplicateCandidateItem,
  QualityAuditCandidateItem,
  CreateItemData,
  UpdateItemData,
} from '@/modules/library/core/types/bibliographic.types';
import { NoteEntity, CreateNoteData } from './types/notes.types';
import { ItemFieldDefinition } from '@/modules/library/core/types/schema.types';
import { LibraryItemSource } from '@/modules/library/core';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  CatalogItemSummary,
} from '@/modules/library/core/ports/catalog.port';
export { CATALOG_FACADE };
export type { ICatalogFacade, CatalogItemSummary };
import { ItemsMapper } from './domain/items.mapper';
export { ItemsMapper };
export {
  resolveOrCreateTags,
  deriveFirstAuthor,
} from './domain/creator-tag-payload.builder';

/**
 * Public Facade for Catalog Bounded Context.
 * Directly communicates with clean, modular services.
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

  async getItem<T = ItemDetail>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null> {
    const raw = await this.queryService.findById(userId, itemId, projectId);
    return raw ? (ItemsMapper.toDomain(raw) as unknown as T) : null;
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

  async findByIds<T = ItemDetail>(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<T[]> {
    const raw = await this.queryService.findByIds(userId, itemIds, projectId);
    return ItemsMapper.toDomainList(raw) as unknown as T[];
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

  async mergeItems(
    tx: Prisma.TransactionClient,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<void> {
    await this.tagsService.mergeTagsToItem(tx, duplicateItemIds, primaryItemId);
    await this.collectionsService.transferItemMemberships(
      duplicateItemIds,
      primaryItemId,
      tx,
    );
    await this.stateService.transferUserItemStates(
      tx,
      duplicateItemIds,
      primaryItemId,
    );
    if (this.notesService) {
      await this.notesService.reassignToItem(
        duplicateItemIds,
        primaryItemId,
        tx,
      );
    }
  }

  async listNotes(
    userId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<NoteEntity[]> {
    return this.notesService.listNotes(userId, itemId, projectId);
  }

  async createNote(userId: string, data: CreateNoteData): Promise<NoteEntity> {
    return this.notesService.createNote(userId, data);
  }

  async listCollections(
    userId: string,
    projectId?: string,
  ): Promise<
    Awaited<ReturnType<CollectionsService['getCollections']>>['collections']
  > {
    const res = await this.collectionsService.getCollections(userId, projectId);
    return res.collections;
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
  ): Promise<{ id: string; itemId: string; metadata?: unknown } | null> {
    if (!this.curationService) return null;
    return this.curationService.findAttachmentByFileId(fileId);
  }

  async updateAttachmentProcessingStatus(
    attachmentId: string,
    status: string,
    metadataPatch?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.curationService) return;
    await this.curationService.updateAttachmentProcessingStatus(
      attachmentId,
      status,
      metadataPatch,
    );
  }

  async updateItemAiMetadata(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
  ): Promise<void> {
    if (!this.curationService) return;
    await this.curationService.updateItemAiMetadata(itemId, aiMetadataPatch);
  }

  async invalidateForWrite(params: {
    userId: string;
    projectId?: string | null;
    itemIds?: string[];
    additionalProjectIds?: Array<string | null | undefined>;
  }): Promise<void> {
    if (!this.cacheCoordinator) return;
    await this.cacheCoordinator.invalidateForWrite(params);
  }
}

export type { DuplicateCandidateItem };
