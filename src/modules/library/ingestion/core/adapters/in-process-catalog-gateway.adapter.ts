import { Injectable, Inject, Optional } from '@nestjs/common';
import {
  CATALOG_GATEWAY_PORT,
  ICatalogGatewayPort,
} from '../ports/catalog-gateway.port';
import {
  CATALOG_FACADE,
  ICatalogFacade,
} from '../../../catalog/catalog.facade';

/**
 * In-process adapter connecting Ingestion to Catalog via CatalogFacade.
 * When separating into independent microservices, this adapter is replaced by HttpCatalogGatewayAdapter.
 */
@Injectable()
export class InProcessCatalogGatewayAdapter implements ICatalogGatewayPort {
  constructor(
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogFacade?: ICatalogFacade,
  ) {}

  getItem(userId: string, itemId: string, projectId?: string) {
    if (!this.catalogFacade) return Promise.resolve(null);
    return this.catalogFacade.getItem(userId, itemId, projectId);
  }

  createItem(userId: string, data: any, options?: any, projectId?: string) {
    if (!this.catalogFacade) {
      throw new Error('CatalogGateway: CatalogFacade is unavailable');
    }
    return this.catalogFacade.createItem(userId, data, options, projectId);
  }

  updateItem(
    userId: string,
    itemId: string,
    data: any,
    expectedVersion?: number,
    projectId?: string,
  ) {
    if (!this.catalogFacade) {
      throw new Error('CatalogGateway: CatalogFacade is unavailable');
    }
    return this.catalogFacade.updateItem(userId, itemId, data, {
      expectedVersion,
      projectId,
    });
  }

  deleteItem(userId: string, itemId: string, projectId?: string) {
    if (!this.catalogFacade) {
      throw new Error('CatalogGateway: CatalogFacade is unavailable');
    }
    return this.catalogFacade.deleteItem(userId, itemId, projectId);
  }

  findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ) {
    if (!this.catalogFacade) return Promise.resolve([]);
    return this.catalogFacade.findDuplicateCandidateItems(
      userId,
      limit,
      projectId,
    );
  }

  findByIds(userId: string, ids: string[], projectId?: string) {
    if (!this.catalogFacade) return Promise.resolve([]);
    return this.catalogFacade.findByIds(userId, ids, projectId);
  }

  mergeItems(tx: any, duplicateItemIds: string[], primaryItemId: string) {
    if (!this.catalogFacade) {
      throw new Error('CatalogGateway: CatalogFacade is unavailable');
    }
    return this.catalogFacade.mergeItems(tx, duplicateItemIds, primaryItemId);
  }

  findQualityAuditItems(userId: string, limit?: number, projectId?: string) {
    if (!this.catalogFacade) return Promise.resolve([]);
    return this.catalogFacade.findQualityAuditItems(userId, limit, projectId);
  }

  getOrderedFields(itemType: string): any[] {
    if (!this.catalogFacade || !this.catalogFacade.getOrderedFields) return [];
    return this.catalogFacade.getOrderedFields(itemType);
  }

  getPrimaryCreatorType(itemType: string): string {
    if (!this.catalogFacade || !this.catalogFacade.getPrimaryCreatorType) {
      return 'author';
    }
    return this.catalogFacade.getPrimaryCreatorType(itemType);
  }

  createNote(userId: string, data: any): Promise<any> {
    if (this.catalogFacade?.createNote) {
      return this.catalogFacade.createNote(userId, data);
    }
    return Promise.resolve(null);
  }

  itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    if (this.catalogFacade?.itemExists) {
      return this.catalogFacade.itemExists(userId, itemId, projectId);
    }
    return Promise.resolve(false);
  }
}
