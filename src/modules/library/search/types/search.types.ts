export interface SearchLibraryDto {
  q?: string;
  itemType?: string;
  yearFrom?: number;
  yearTo?: number;
  authors?: string[];
  tags?: string[];
  collectionId?: string;
  readStatus?: 'unread' | 'reading' | 'completed';
  hasPdf?: boolean;
  sortBy?: 'relevance' | 'dateAdded' | 'year' | 'title';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface FacetCount<T = string> {
  value: T;
  count: number;
}

export interface SearchFacetsResult {
  itemTypes: FacetCount<string>[];
  years: FacetCount<number>[];
  topAuthors: FacetCount<string>[];
  tags: FacetCount<string>[];
  readStatuses: FacetCount<string>[];
}

export interface SavedSearch {
  id: string;
  workspaceId: string;
  name: string;
  criteria: SearchLibraryDto;
  createdAt: string;
  updatedAt: string;
}
