import { SearchQueryVo } from '../domain/search-query.vo';

export const SEARCH_ENGINE_PORT = Symbol('SEARCH_ENGINE_PORT');
export const VECTOR_SEARCH_ENGINE_PORT = Symbol('VECTOR_SEARCH_ENGINE_PORT');

export interface SearchHit {
  id: string;
  title: string;
  doi?: string | null;
  abstract?: string | null;
  year?: number | null;
  score?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
}

/** Full-text search (Postgres tsvector, read replica) */
export interface ISearchEnginePort {
  search(
    userId: string,
    query: SearchQueryVo,
    projectId?: string,
  ): Promise<SearchResult>;
}

/** Semantic/Vector KNN search (pgvector / Qdrant — GPU-backed) */
export interface IVectorSearchEnginePort {
  semanticSearch(
    userId: string,
    queryText: string,
    limit?: number,
    projectId?: string,
  ): Promise<SearchResult>;
}
