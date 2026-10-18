export interface SearchOptions {
  q?: string;
  itemType?: string;
  collectionId?: string;
  tagId?: string;
  yearFrom?: number;
  yearTo?: number;
  sortBy?: 'relevance' | 'dateAdded' | 'createdAt' | 'year' | 'title';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
  projectId?: string;
}

export interface SearchQuery {
  query: string;
  limit: number;
  offset: number;
  sortBy: 'relevance' | 'date' | 'title';
}

export interface FacetResult {
  itemTypes: Record<string, number>;
  years: Record<number, number>;
  tags: Record<string, number>;
  collections?: Record<string, number>;
}

export interface SearchResultItem {
  id: string;
  title: string;
  year: number | null;
  itemType: string | null;
  authors: string[];
  matchHighlight?: string;
}
