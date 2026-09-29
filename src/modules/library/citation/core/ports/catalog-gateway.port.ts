/**
 * Catalog Gateway Port — Citation Bounded Context
 *
 * Defines the contract through which Citation retrieves bibliographic items.
 * Decouples Citation from direct in-process Catalog dependencies.
 *
 * In monolith: implemented by InProcessCatalogGatewayAdapter (delegates to CatalogFacade).
 * In microservices: implemented by HttpCatalogGatewayAdapter (calls Catalog microservice REST/gRPC API).
 */
export const CATALOG_GATEWAY_PORT = Symbol('CITATION_CATALOG_GATEWAY_PORT');

export interface ICatalogGatewayPort {
  getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any | null>;

  findByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<any[]>;
}
