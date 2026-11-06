export * from './library.module';

// Re-export Facades & Ports for External Subsystems (Decoupled Boundaries)
export { CatalogFacade, CATALOG_FACADE } from './catalog/services/library-bootstrap.service';
export type { ICatalogFacade } from './catalog/services/library-bootstrap.service';

export { CitationFacade, CITATION_FACADE } from './citation/services/exports.service';
export type { ICitationFacade } from './citation/services/exports.service';

export {
  ExtractionFacade,
  EXTRACTION_FACADE,
} from './extraction/services/reference-matcher.service';
export type { IExtractionFacade } from './extraction/services/reference-matcher.service';

export {
  IngestionFacade,
  INGESTION_FACADE,
} from './ingestion/services/ingestion-verifier.service';
export type { IIngestionFacade } from './ingestion/services/ingestion-verifier.service';

export { SearchFacade, SEARCH_FACADE } from './search/services/search.service';
export type { ISearchFacade } from './search/services/search.service';

