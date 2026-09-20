import { SearchQueryVo } from '../value-objects/search-query.vo';

export const SEARCH_ENGINE_PORT = Symbol('SEARCH_ENGINE_PORT');

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

export interface ISearchEnginePort {
  search(
    userId: string,
    query: SearchQueryVo,
    projectId?: string,
  ): Promise<SearchResult>;
}
