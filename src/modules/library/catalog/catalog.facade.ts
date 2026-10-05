import { Injectable, Optional, Inject } from '@nestjs/common';
import { ItemsService } from './core/services/items.service';
import { QueryRepository } from './core/adapters/query.repository';
import { CollectionsService } from './core/services/collections.service';
import { TagsService } from './core/services/tags.service';
import { TypesService } from './core/services/types.service';
import { StateService } from './core/services/state.service';
import { NotesService } from './core/services/notes.service';
import {
  ITEM_READ_PORT,
  ITEM_EXISTENCE_PORT,
  IItemReadPort,
  IItemExistencePort,
  ItemDetail,
  ItemSummary,
  DuplicateCandidateItem,
} from './core/ports/items.ports';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from './core/ports/item-repository.port';
import { CreateItemUseCase } from './core/use-cases/create-item.use-case';
import { UpdateItemUseCase } from './core/use-cases/update-item.use-case';
import { sanitizeItemTitle } from '../shared-kernel/utils/bibliographic.utils';
import { ItemFieldDefinition } from '../shared-kernel/types/schema.types';

export const CATALOG_FACADE = 'CATALOG_FACADE';
export const BIBLIOGRAPHY_FACADE = CATALOG_FACADE;

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
  ): Promise<any[]>;
  getItemState(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any>;
  createItem(
    userId: string,
    data: any,
    options?: any,
    projectId?: string,
  ): Promise<any>;
  updateItem(
    userId: string,
    itemId: string,
    data: any,
    options?: any,
  ): Promise<any>;
  deleteItem(userId: string, itemId: string, projectId?: string): Promise<void>;
  findByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<any[]>;
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
    tx: any,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<void>;
  listNotes?(
    userId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<any[]>;
  createNote?(userId: string, data: any): Promise<any>;
}

/**
 * Public Facade for Catalog Bounded Context (Core Domain).
 * Shields catalog internal repositories and submodules from external callers.
 */
@Injectable()
export class CatalogFacade implements ICatalogFacade {
  constructor(
    @Inject(ITEM_READ_PORT)
    @Optional()
    private readonly itemReadPort?: IItemReadPort,
    @Inject(ITEM_EXISTENCE_PORT)
    @Optional()
    private readonly itemExistencePort?: IItemExistencePort,
    @Inject(ITEM_REPOSITORY_PORT)
    @Optional()
    private readonly itemRepo?: IItemRepositoryPort,
    @Optional() private readonly createItemUseCase?: CreateItemUseCase,
    @Optional() private readonly updateItemUseCase?: UpdateItemUseCase,
    @Optional() private readonly itemsService?: ItemsService,
    @Optional() private readonly queryRepo?: QueryRepository,
    @Optional() private readonly collectionsService?: CollectionsService,
    @Optional() private readonly tagsService?: TagsService,
    @Optional() private readonly typesService?: TypesService,
    @Optional() private readonly stateService?: StateService,
    @Optional() private readonly notesService?: NotesService,
  ) {}

  async getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemDetail | null> {
    if (this.itemReadPort) {
      return this.itemReadPort.findById(userId, itemId, projectId);
    }
    if (this.itemsService) {
      return this.itemsService.findById(userId, itemId, projectId);
    }
    return null;
  }

  async getItemSummary(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemSummary | null> {
    if (this.itemReadPort) {
      return this.itemReadPort.findSummaryById(userId, itemId, projectId);
    }
    if (this.itemsService) {
      return this.itemsService.findSummaryById(userId, itemId, projectId);
    }
    return null;
  }

  async itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    if (this.itemExistencePort) {
      return this.itemExistencePort.exists(userId, itemId, projectId);
    }
    if (this.itemsService) {
      return this.itemsService.exists(userId, itemId, projectId);
    }
    return false;
  }

  async getTags(
    userId: string,
    options?: { includeInactive?: boolean; projectId?: string },
  ): Promise<any[]> {
    if (!this.tagsService) return [];
    return this.tagsService.getTags(userId, options);
  }

  async getItemState(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any> {
    if (!this.stateService) return null;
    return this.stateService.getState(userId, itemId, projectId);
  }

  async createItem(
    userId: string,
    data: any,
    options?: any,
    projectId?: string,
  ): Promise<any> {
    if (this.createItemUseCase) {
      const cleanTitle = data.title ? sanitizeItemTitle(data.title) : '';
      return this.createItemUseCase.execute({
        userId,
        projectId: projectId || data.projectId || undefined,
        title: cleanTitle || data.title || 'Untitled',
        itemType: data.itemType ?? 'journalArticle',
        doi: data.doi,
        citationKey: data.citationKey,
        abstract: data.abstract,
        year: data.year ? parseInt(data.year, 10) : undefined,
        publicationTitle: data.publicationTitle,
        fields: data.fields ?? data,
      });
    }
    if (this.itemsService) {
      return this.itemsService.createItem(userId, data, options, projectId);
    }
    throw new Error('No provider available for createItem in CatalogFacade');
  }

  async updateItem(
    userId: string,
    itemId: string,
    data: any,
    options?: any,
  ): Promise<any> {
    if (this.updateItemUseCase) {
      return this.updateItemUseCase.execute({
        userId,
        itemId,
        projectId: data.projectId,
        expectedVersion: options?.expectedVersion,
        changes: {
          title: data.title,
          itemType: data.itemType,
          doi: data.doi,
          citationKey: data.citationKey,
          abstract: data.abstract,
          year: data.year ? parseInt(data.year, 10) : undefined,
          publicationTitle: data.publicationTitle,
          fields: data.fields ?? data,
        },
      });
    }
    if (this.itemsService) {
      return this.itemsService.updateItem(userId, itemId, data, options);
    }
    throw new Error('No provider available for updateItem in CatalogFacade');
  }

  async deleteItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    if (this.itemRepo) {
      await this.itemRepo.delete(userId, itemId, projectId);
    }
  }

  async findByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<any[]> {
    if (this.itemReadPort) {
      return this.itemReadPort.findByIds(userId, itemIds, projectId);
    }
    if (!this.itemsService) return [];
    return this.itemsService.findByIds(userId, itemIds, projectId);
  }

  async countItems(userId: string, options?: any): Promise<number> {
    if (!this.queryRepo) return 0;
    return this.queryRepo.count(userId, options || { view: 'all' });
  }

  async findMany(userId: string, options?: any): Promise<any[]> {
    if (!this.queryRepo) return [];
    return this.queryRepo.findMany(userId, options);
  }

  validateItemType(type: string): Promise<boolean> {
    if (!this.typesService) return Promise.resolve(true);
    return Promise.resolve(this.typesService.isValidType(type));
  }

  getPrimaryCreatorType(itemType: string): string {
    if (!this.typesService) return 'author';
    return this.typesService.getPrimaryCreatorType(itemType);
  }

  getOrderedFields(itemType: string): ItemFieldDefinition[] {
    if (!this.typesService) return [];
    return this.typesService.getOrderedFields(itemType);
  }

  async findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<any[]> {
    if (this.itemReadPort) {
      return this.itemReadPort.findQualityAuditItems(userId, limit, projectId);
    }
    if (!this.itemsService) return [];
    return this.itemsService.findQualityAuditItems(userId, limit, projectId);
  }

  async findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<DuplicateCandidateItem[]> {
    if (this.itemReadPort) {
      return this.itemReadPort.findDuplicateCandidateItems(
        userId,
        limit,
        projectId,
      );
    }
    if (!this.itemsService) return [];
    return this.itemsService.findDuplicateCandidateItems(
      userId,
      limit,
      projectId,
    );
  }

  async mergeItems(
    tx: any,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<void> {
    if (this.tagsService) {
      await this.tagsService.mergeTagsToItem(
        tx,
        duplicateItemIds,
        primaryItemId,
      );
    }
    if (this.collectionsService) {
      await this.collectionsService.transferItemMemberships(
        duplicateItemIds,
        primaryItemId,
        tx,
      );
    }
    if (this.stateService) {
      await this.stateService.transferUserItemStates(
        tx,
        duplicateItemIds,
        primaryItemId,
      );
    }
  }

  async listNotes(
    userId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<any[]> {
    if (!this.notesService) return [];
    return this.notesService.listNotes(userId, itemId, projectId);
  }

  async createNote(userId: string, data: any): Promise<any> {
    if (!this.notesService) return null;
    return this.notesService.createNote(userId, data);
  }
}

export type { DuplicateCandidateItem };
