/**
 * ISearchPort — canonical interface for Library search operations.
 *
 * Allows swapping search backends (PostgreSQL FTS, Meilisearch, etc.)
 * without changing SearchService callers.
 */

export const SEARCH_PORT = Symbol('SEARCH_PORT');

export interface SearchOptions {
  q?: string;
  filters?: Record<string, string | string[]>;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export interface SearchItemResult {
  id: string;
  title?: string;
  doi?: string;
  year?: number;
  itemType?: string;
  score?: number;
}

export interface SearchItemsResult {
  items: SearchItemResult[];
  total: number;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface FacetResult {
  itemTypes: FacetValue[];
  years: FacetValue[];
}

export interface ISearchPort {
  searchItems(
    workspaceId: string,
    opts: SearchOptions,
  ): Promise<SearchItemsResult>;

  computeFacets(
    workspaceId: string,
    opts: SearchOptions,
  ): Promise<FacetResult>;
}
