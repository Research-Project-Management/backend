export const SEARCH_ENGINE_PORT = Symbol('SEARCH_ENGINE_PORT');
export const VECTOR_SEARCH_ENGINE_PORT = Symbol('VECTOR_SEARCH_ENGINE_PORT');

export interface SearchQuery {
  query: string;
  limit: number;
  offset: number;
  sortBy: 'relevance' | 'date' | 'title';
}

export function createSearchQuery(
  rawQuery: string,
  options?: { limit?: number; offset?: number; sortBy?: string },
): SearchQuery {
  const trimmed = (rawQuery ?? '').trim();
  const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
  const offset = Math.max(0, options?.offset ?? 0);
  const sortBy =
    options?.sortBy === 'date' || options?.sortBy === 'title'
      ? options.sortBy
      : 'relevance';

  return {
    query: trimmed,
    limit,
    offset,
    sortBy,
  };
}

/** Backward-compatibility wrapper for SearchQuery */
export class SearchQueryVo implements SearchQuery {
  public readonly query: string;
  public readonly limit: number;
  public readonly offset: number;
  public readonly sortBy: 'relevance' | 'date' | 'title';

  constructor(props: SearchQuery) {
    this.query = props.query;
    this.limit = props.limit;
    this.offset = props.offset;
    this.sortBy = props.sortBy;
  }

  public static create(
    rawQuery: string,
    options?: { limit?: number; offset?: number; sortBy?: string },
  ): SearchQueryVo {
    const created = createSearchQuery(rawQuery, options);
    return new SearchQueryVo(created);
  }
}

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
    query: SearchQuery,
    projectId?: string,
  ): Promise<SearchResult>;
}

/** Semantic/Vector KNN search (pgvector / Qdrant — GPU-backed) */
export interface IVectorSearchEnginePort {
  isAvailable(): boolean;
  semanticSearch(
    userId: string,
    queryText: string,
    limit?: number,
    projectId?: string,
  ): Promise<SearchResult>;
}
