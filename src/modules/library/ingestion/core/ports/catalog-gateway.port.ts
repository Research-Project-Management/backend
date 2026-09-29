/**
 * Catalog Gateway Port — Processing / Ingestion Bounded Context
 *
 * Defines the contract through which Ingestion interacts with the Catalog Bounded Context.
 * Decouples Ingestion from direct in-process Catalog dependencies.
 *
 * In a monolith: implemented by InProcessCatalogGatewayAdapter (delegates to CatalogFacade).
 * In microservices: implemented by HttpCatalogGatewayAdapter (remote REST / gRPC call).
 */

export const CATALOG_GATEWAY_PORT = Symbol('CATALOG_GATEWAY_PORT');

export interface ICatalogGatewayPort {
  getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any | null>;
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
    expectedVersion?: number,
    projectId?: string,
  ): Promise<any>;
  deleteItem(userId: string, itemId: string, projectId?: string): Promise<void>;
  findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<any[]>;
  findByIds(userId: string, ids: string[], projectId?: string): Promise<any[]>;
  mergeItems(
    tx: any,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<void>;
  findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<any[]>;
  getOrderedFields?(itemType: string): any[];
  getPrimaryCreatorType?(itemType: string): string;
  createNote?(userId: string, data: any): Promise<any>;
  itemExists?(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean>;
}
