import { Injectable, Optional } from '@nestjs/common';
import { ItemsService } from './application/services/items.service';
import { QueryRepository } from './infrastructure/repositories/query.repository';
import { CollectionsService } from './application/services/collections.service';
import { TagsService } from './application/services/tags.service';
import { TypesService } from './application/services/types.service';
import { StateService } from './application/services/state.service';
import { ItemDetail, ItemSummary } from './domain/ports/items.ports';

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
  ): Promise<any[]>;
  getItemState(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any>;
  createItem(userId: string, data: any, options?: any, projectId?: string): Promise<any>;
  updateItem(userId: string, itemId: string, data: any, options?: any): Promise<any>;
  findByIds(userId: string, itemIds: string[], projectId?: string): Promise<any[]>;
  countItems(scopeId: string, options?: any): Promise<number>;
  findMany(scopeId: string, options?: any): Promise<any[]>;
  validateItemType(type: string): Promise<boolean>;
  getPrimaryCreatorType(itemType: string): string;
}


/**
 * Public Facade for Catalog Bounded Context (Core Domain).
 * Shields catalog internal repositories and submodules from external callers.
 */
@Injectable()
export class CatalogFacade implements ICatalogFacade {
  constructor(
    @Optional() private readonly itemsService?: ItemsService,
    @Optional() private readonly queryRepo?: QueryRepository,
    @Optional() private readonly collectionsService?: CollectionsService,
    @Optional() private readonly tagsService?: TagsService,
    @Optional() private readonly typesService?: TypesService,
    @Optional() private readonly stateService?: StateService,
  ) {}

  async getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemDetail | null> {
    if (!this.itemsService) return null;
    return this.itemsService.findById(userId, itemId, projectId);
  }

  async getItemSummary(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemSummary | null> {
    if (!this.itemsService) return null;
    return this.itemsService.findSummaryById(userId, itemId, projectId);
  }

  async itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    if (!this.itemsService) return false;
    return this.itemsService.exists(userId, itemId, projectId);
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
    if (!this.itemsService) {
      throw new Error('ItemsService not initialized in CatalogFacade');
    }
    return this.itemsService.createItem(userId, data, options, projectId);
  }

  async updateItem(
    userId: string,
    itemId: string,
    data: any,
    options?: any,
  ): Promise<any> {
    if (!this.itemsService) {
      throw new Error('ItemsService not initialized in CatalogFacade');
    }
    return this.itemsService.updateItem(userId, itemId, data, options);
  }

  async findByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<any[]> {
    if (!this.itemsService) return [];
    return this.itemsService.findByIds(userId, itemIds, projectId);
  }

  async countItems(scopeId: string, options?: any): Promise<number> {
    if (!this.queryRepo) return 0;
    return this.queryRepo.count(scopeId, options || { view: 'all' });
  }

  async findMany(scopeId: string, options?: any): Promise<any[]> {
    if (!this.queryRepo) return [];
    return this.queryRepo.findMany(scopeId, options);
  }

  validateItemType(type: string): Promise<boolean> {
    if (!this.typesService) return Promise.resolve(true);
    return Promise.resolve(this.typesService.isValidType(type));
  }

  getPrimaryCreatorType(itemType: string): string {
    if (!this.typesService) return 'author';
    return this.typesService.getPrimaryCreatorType(itemType);
  }
}

