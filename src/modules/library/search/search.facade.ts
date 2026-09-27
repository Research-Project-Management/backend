import { Injectable, Optional } from '@nestjs/common';
import { SearchService } from './application/services/search.service';
import { SearchItemsQueryDto } from './application/dtos/search.dto';

export const SEARCH_FACADE = 'SEARCH_FACADE';

export interface ISearchFacade {
  search(userId: string, queryDto: SearchItemsQueryDto): Promise<{
    items: unknown[];
    facets?: unknown;
    meta?: {
      cursor?: string;
      hasNextPage: boolean;
      pageCount: number;
    };
  }>;
  indexItem(item: { id: string }): Promise<void>;
  reindexItem(item: { id: string }): Promise<{
    localIndexed: boolean;
    error?: string;
  }>;
}

@Injectable()
export class SearchFacade implements ISearchFacade {
  constructor(
    @Optional() private readonly searchService?: SearchService,
  ) {}

  async search(userId: string, queryDto: SearchItemsQueryDto): Promise<{
    items: unknown[];
    facets?: unknown;
    meta?: {
      cursor?: string;
      hasNextPage: boolean;
      pageCount: number;
    };
  }> {
    if (!this.searchService) return { items: [], meta: { hasNextPage: false, pageCount: 0 } };
    return this.searchService.search(userId, queryDto);
  }

  indexItem(_item: { id: string }): Promise<void> {
    // In Library Bounded Context, indexing is handled via FTS in SearchService
    return Promise.resolve();
  }

  reindexItem(_item: { id: string }): Promise<{
    localIndexed: boolean;
    error?: string;
  }> {
    return Promise.resolve({ localIndexed: true });
  }
}
