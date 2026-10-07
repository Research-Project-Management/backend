import { Injectable, Inject, Optional } from '@nestjs/common';
import {
  CATALOG_GATEWAY_PORT,
  ICatalogGatewayPort,
} from '../types/catalog-gateway.types';
import { CATALOG_FACADE, ICatalogFacade } from '../../shared-kernel';

/**
 * In-process adapter connecting Extraction to Catalog via CatalogFacade.
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
