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
 * In-process adapter connecting Extraction to Catalog via CatalogFacade.
 * When Catalog is extracted into a microservice, swap this adapter with HttpCatalogGatewayAdapter.
 */
@Injectable()
export class InProcessCatalogGatewayAdapter implements ICatalogGatewayPort {
  constructor(
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogFacade?: ICatalogFacade,
  ) {}

  itemExists(userId: string, itemId: string, projectId?: string) {
    if (!this.catalogFacade) return Promise.resolve(false);
    return this.catalogFacade.itemExists(userId, itemId, projectId);
  }

  getItem(userId: string, itemId: string, projectId?: string) {
    if (!this.catalogFacade) return Promise.resolve(null);
    return this.catalogFacade.getItem(userId, itemId, projectId);
  }
}
