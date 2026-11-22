export * from './library.module';

// Re-export Facades & Ports for External Subsystems (Decoupled Boundaries)
export {
  CatalogFacade,
  CATALOG_FACADE,
} from './catalog/services/catalog.facade';
export type { ICatalogFacade } from './catalog/services/catalog.facade';

export {
  CitationFacade,
  CITATION_FACADE,
} from './citation/services/citation.facade';
export type { ICitationFacade } from './citation/services/citation.facade';

export {
  ExtractionFacade,
  EXTRACTION_FACADE,
} from './extraction/services/reference-matcher.service';
export type { IExtractionFacade } from './extraction/services/reference-matcher.service';

export {
  IngestionFacade,
  INGESTION_FACADE,
} from './ingestion/services/ingestion.facade';
export type { IIngestionFacade } from './ingestion/services/ingestion.facade';

export { SearchFacade, SEARCH_FACADE } from './search/services/search.facade';
export type { ISearchFacade } from './search/services/search.facade';
