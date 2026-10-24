import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ItemService } from './services/items.service';
import { ItemQueryService } from './services/item-query.service';
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
} from '@/modules/library/core/ports/catalog.port';
export { CATALOG_FACADE };
export type { ICatalogFacade };
export type CatalogItemSummary = ItemDetail;
export { ItemsMapper } from './domain/items.mapper';
export {
  resolveOrCreateTags,
  deriveFirstAuthor,
} from './domain/creator-tag-payload.builder';

/**
 * Public Facade for Catalog Bounded Context.
 * Directly communicates with clean, modular services.
 */
@Injectable()
export class CatalogFacade {
  constructor(
    private readonly queryService: ItemQueryService,
    private readonly itemService: ItemService,
    private readonly collectionsService: CollectionsService,
    private readonly tagsService: TagsService,
    private readonly typesService: TypesService,
    private readonly stateService: StateService,
    private readonly notesService: NotesService,
  ) {}

  async getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemDetail | null> {
    return this.queryService.findById(userId, itemId, projectId);
  }

  async itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    return this.queryService.exists(userId, itemId, projectId);
  }

  async createItem(
    userId: string,
    data: CreateItemData,
    options?: {
      expectedVersion?: number;
      suppressIndexing?: boolean;
      projectId?: string;
      source?: LibraryItemSource;
      idempotencyKey?: string;
      correlationId?: string;
    },
    projectId?: string,
  ): Promise<ItemDetail> {
    return this.itemService.createItem(userId, data, options, projectId);
  }

  async updateItem(
    userId: string,
    itemId: string,
    data: UpdateItemData,
    options?: { expectedVersion?: number; projectId?: string },
  ): Promise<ItemDetail> {
    return this.itemService.updateItem(
      userId,
      itemId,
      options?.expectedVersion,
      data,
      undefined,
      options?.projectId,
    );
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

  async findByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<ItemDetail[]> {
    return this.queryService.findByIds(userId, itemIds, projectId);
  }

  async countItems(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<number> {
    return this.queryService.count(userId, options || { view: 'all' });
  }

  async findMany(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<ItemDetail[]> {
    return this.queryService.findMany(userId, options || {});
  }

  getOrderedFields(itemType: string): ItemFieldDefinition[] {
    return this.typesService.getOrderedFields(itemType);
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
  ): Promise<Awaited<ReturnType<CollectionsService['getCollections']>>['collections']> {
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
      titleWords?: string[];
      titlePrefix?: string;
    },
  ) {
    return this.queryService.findMatchCandidates(scope, criteria);
  }
}

export type { DuplicateCandidateItem };
