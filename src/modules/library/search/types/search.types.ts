export interface SearchOptions {
  q?: string;
  searchMode?: 'title_creator_year' | 'fields_tags' | 'everything' | string;
  view?:
    | 'all'
    | 'recent'
    | 'unfiled'
    | 'trash'
    | 'my-publications'
    | 'publications'
    | 'starred'
    | 'retracted'
    | string;
  itemType?: string | string[];
  type?: string;
  collectionId?: string;
  collectionIds?: string[];
  targetCollectionIds?: string[];
  includeSubcollections?: boolean;
  recursive?: boolean;
  tagId?: string;
  tag?: string;
  hasFile?: boolean;
  hasNotes?: boolean;
  isRetracted?: boolean;
  onlyFlagged?: boolean;
  readStatus?: string;
  yearFrom?: number;
  yearTo?: number;
  fromYear?: number;
  toYear?: number;
  sortBy?:
    | 'relevance'
    | 'dateAdded'
    | 'createdAt'
    | 'updatedAt'
    | 'year'
    | 'title'
    | 'authors'
    | 'firstAuthor'
    | 'publication'
    | 'publicationTitle'
    | 'citationKey'
    | string;
  sortOrder?: 'asc' | 'desc';
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
  limit?: number;
  page?: number;
  cursor?: string;
  projectId?: string;
}

export interface FacetResult {
  itemTypes: Record<string, number>;
  years: Record<number, number>;
  tags: Record<string, number>;
  collections?: Record<string, number>;
}

export interface PageTextExtraction {
  pageIndex: number;
  textContent: string;
  charOffset?: number;
  itemId?: string;
}

export interface PageAnchorMatch {
  attachmentId: string;
  pageIndex: number;
  snippet: string;
  charOffsetStart: number;
  charOffsetEnd: number;
  /** Alias for frontend SDK compatibility */
  text: string;
  /** Alias for frontend SDK compatibility */
  startOffset: number;
  /** Alias for frontend SDK compatibility */
  endOffset: number;
}
