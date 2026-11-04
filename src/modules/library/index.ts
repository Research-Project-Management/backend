export * from './library.module';
export * from './library.facade';

// Re-export Facades & Ports for External Subsystems (Decoupled Boundaries)
export {
  ExtractionFacade,
  EXTRACTION_FACADE,
} from './extraction/services/reference-matcher.service';
export type { IExtractionFacade } from './extraction/services/reference-matcher.service';

export { CatalogFacade, CATALOG_FACADE } from './catalog/services/library-bootstrap.service';
export type { ICatalogFacade } from './catalog/services/library-bootstrap.service';

export { CitationFacade, CITATION_FACADE } from './citation/services/citation.service';
export type { ICitationFacade } from './citation/services/citation.service';

export {
  IngestionFacade,
  INGESTION_FACADE,
} from './ingestion/controllers/ingestion.controller';
export type { IIngestionFacade } from './ingestion/controllers/ingestion.controller';

export { SearchFacade, SEARCH_FACADE } from './search/controllers/search.controller';
export type { ISearchFacade } from './search/controllers/search.controller';
