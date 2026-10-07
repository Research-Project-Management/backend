export * from './library.module';
export * from './library.facade';

// Re-export Facades & Ports for External Subsystems (Decoupled Boundaries)
export {
  ExtractionFacade,
  EXTRACTION_FACADE,
} from './extraction/extraction.facade';
export type { IExtractionFacade } from './extraction/extraction.facade';

export { CatalogFacade, CATALOG_FACADE } from './catalog/catalog.facade';
export type { ICatalogFacade } from './catalog/catalog.facade';

export { CitationFacade, CITATION_FACADE } from './citation/citation.facade';
export type { ICitationFacade } from './citation/citation.facade';

export {
  IngestionFacade,
  INGESTION_FACADE,
} from './ingestion/ingestion.facade';
export type { IIngestionFacade } from './ingestion/ingestion.facade';

export { SearchFacade, SEARCH_FACADE } from './search/search.facade';
export type { ISearchFacade } from './search/search.facade';

// Export canonical bounded contexts as isolated namespaces to avoid TS2308 collision
export * as Catalog from './catalog';
export * as Citation from './citation';
export * as Extraction from './extraction';
export * as Ingestion from './ingestion';
export * as Search from './search';
export * as Sync from './sync';
export * as SharedKernel from './shared-kernel';
