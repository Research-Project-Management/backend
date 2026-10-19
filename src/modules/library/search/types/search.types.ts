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

export interface FacetResult {
  itemTypes: Record<string, number>;
  years: Record<number, number>;
  tags: Record<string, number>;
  collections?: Record<string, number>;
}
