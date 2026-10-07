import { Injectable, Inject, Optional } from '@nestjs/common';
import {
  CATALOG_GATEWAY_PORT,
  ICatalogGatewayPort,
} from '../types/citation.types';
import { CATALOG_FACADE, ICatalogFacade } from '../../shared-kernel';

/**
 * In-process adapter connecting Citation to Catalog via CatalogFacade.
 * When Catalog is extracted into a microservice, swap this adapter with HttpCatalogGatewayAdapter.
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

  findByIds(userId: string, itemIds: string[], projectId?: string) {
    if (!this.catalogFacade) return Promise.resolve([]);
    return this.catalogFacade.findByIds(userId, itemIds, projectId);
  }
}
