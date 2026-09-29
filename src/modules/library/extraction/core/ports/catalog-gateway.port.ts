/**
 * Catalog Gateway Port — Extraction Bounded Context
 *
 * Defines the contract through which Extraction verifies item existence in Catalog.
 * Decouples Extraction from direct in-process Catalog dependencies.
 *
 * In monolith: implemented by InProcessCatalogGatewayAdapter (delegates to CatalogFacade).
 * In microservices: implemented by HttpCatalogGatewayAdapter (calls Catalog microservice REST/gRPC API).
 */
export const CATALOG_GATEWAY_PORT = Symbol('EXTRACTION_CATALOG_GATEWAY_PORT');

export interface ICatalogGatewayPort {
  itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean>;

  getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any | null>;
}
