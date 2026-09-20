import { Injectable, Optional } from '@nestjs/common';
import { ItemsService } from './application/services/items.service';
import { QueryRepository } from './infrastructure/repositories/query.repository';
import { CollectionsService } from './application/services/collections.service';
import { TagsService } from './application/services/tags.service';
import { TypesService } from './application/services/types.service';
import { StateService } from './application/services/state.service';
import {
  ItemDetail,
  ItemSummary,
  DuplicateCandidateItem,
} from './domain/ports/items.ports';
import { ItemFieldDefinition } from '../shared-kernel/types/schema.types';

export const BIBLIOGRAPHY_FACADE = 'BIBLIOGRAPHY_FACADE';
export const CATALOG_FACADE = BIBLIOGRAPHY_FACADE;

export interface IBibliographyFacade {
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
  findByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<any[]>;
  countItems(scopeId: string, options?: any): Promise<number>;
  findMany(scopeId: string, options?: any): Promise<any[]>;
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
}

export type ICatalogFacade = IBibliographyFacade;

/**
 * Public Facade for Bibliography Bounded Context (Core Domain).
 * Shields bibliography internal repositories and submodules from external callers.
 */
@Injectable()
export class BibliographyFacade implements IBibliographyFacade {
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

  getOrderedFields(itemType: string): ItemFieldDefinition[] {
    if (!this.typesService) return [];
    return this.typesService.getOrderedFields(itemType);
  }

  async findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<any[]> {
    if (!this.itemsService) return [];
    return this.itemsService.findQualityAuditItems(userId, limit, projectId);
  }

  async findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<DuplicateCandidateItem[]> {
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
}

export { BibliographyFacade as CatalogFacade };
export type { DuplicateCandidateItem };
