import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ItemService } from './services/items.service';
import { ItemQueryService } from './services/item-query.service';
import { QueryRepository } from './repositories/query.repository';
import { CollectionsService } from './services/collections.service';
import { TagsService } from './services/tags.service';
import { TypesService } from './services/types.service';
import { StateService } from './services/state.service';
import { NotesService } from './services/notes.service';
import {
  ItemDetail,
  ItemSummary,
  DuplicateCandidateItem,
  CreateItemData,
  UpdateItemData,
} from './types/items.types';
import { TagEntity } from './types/tags.types';
import { StateData } from './types/state.types';
import { NoteEntity, CreateNoteData } from './types/notes.types';
import { ItemFieldDefinition } from '../shared-kernel/types/schema.types';

export const CATALOG_FACADE = 'CATALOG_FACADE';

export interface ICatalogFacade {
  getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemDetail | null>;
  getItemSummary(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemSummary | null>;
  itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean>;
  getTags(
    userId: string,
    options?: { includeInactive?: boolean; projectId?: string },
  ): Promise<TagEntity[]>;
  getItemState(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<StateData | null>;
  createItem(
    userId: string,
    data: CreateItemData,
    options?: any,
    projectId?: string,
  ): Promise<any>;
  updateItem(
    userId: string,
    itemId: string,
    data: UpdateItemData,
    options?: { expectedVersion?: number; projectId?: string },
  ): Promise<any>;
  deleteItem(userId: string, itemId: string, projectId?: string): Promise<void>;
  findByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<ItemDetail[]>;
  countItems(userId: string, options?: any): Promise<number>;
  findMany(userId: string, options?: any): Promise<any[]>;
  validateItemType(type: string): Promise<boolean>;
  getPrimaryCreatorType(itemType: string): string;
  getOrderedFields(itemType: string): ItemFieldDefinition[];
  findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<any[]>;
  findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<DuplicateCandidateItem[]>;
  mergeItems(
    tx: Prisma.TransactionClient,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<void>;
  listNotes(
    userId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<NoteEntity[]>;
  createNote(userId: string, data: CreateNoteData): Promise<NoteEntity>;
}

/**
 * Public Facade for Catalog Bounded Context.
 * Directly communicates with clean, modular services.
 */
@Injectable()
export class CatalogFacade implements ICatalogFacade {
  constructor(
    private readonly queryService: ItemQueryService,
    private readonly itemService: ItemService,
    private readonly queryRepo: QueryRepository,
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

  async getItemSummary(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemSummary | null> {
    return this.queryService.findSummaryById(userId, itemId, projectId);
  }

  async itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    return this.queryService.exists(userId, itemId, projectId);
  }

  async getTags(
    userId: string,
    options?: { includeInactive?: boolean; projectId?: string },
  ): Promise<TagEntity[]> {
    return this.tagsService.getTags(userId, options);
  }

  async getItemState(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<StateData | null> {
    return this.stateService.getState(userId, itemId, projectId);
  }

  async createItem(
    userId: string,
    data: CreateItemData,
    options?: any,
    projectId?: string,
  ): Promise<any> {
    return this.itemService.createItem(userId, data, options, projectId);
  }

  async updateItem(
    userId: string,
    itemId: string,
    data: UpdateItemData,
    options?: { expectedVersion?: number; projectId?: string },
  ): Promise<any> {
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

  async countItems(userId: string, options?: any): Promise<number> {
    return this.queryRepo.count(userId, options || { view: 'all' });
  }

  async findMany(userId: string, options?: any): Promise<any[]> {
    return this.queryRepo.findMany(userId, options);
  }

  validateItemType(type: string): Promise<boolean> {
    return Promise.resolve(this.typesService.isValidType(type));
  }

  getPrimaryCreatorType(itemType: string): string {
    return this.typesService.getPrimaryCreatorType(itemType);
  }

  getOrderedFields(itemType: string): ItemFieldDefinition[] {
    return this.typesService.getOrderedFields(itemType);
  }

  async findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<any[]> {
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
}

export type { DuplicateCandidateItem };
