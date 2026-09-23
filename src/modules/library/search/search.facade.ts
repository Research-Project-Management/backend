import { Injectable, Optional } from '@nestjs/common';
import { SearchService } from './application/services/search.service';

export const SEARCH_FACADE = 'SEARCH_FACADE';

export interface ISearchFacade {
  search(userId: string, queryDto: any): Promise<any>;
  indexItem(item: any): Promise<void>;
  reindexItem(item: any): Promise<{
    localIndexed: boolean;
    error?: string;
  }>;
}

@Injectable()
export class SearchFacade implements ISearchFacade {
  constructor(
    @Optional() private readonly searchService?: SearchService,
  ) {}

  async search(userId: string, queryDto: any): Promise<any> {
    if (!this.searchService) return { items: [], total: 0 };
    return this.searchService.search(userId, queryDto);
  }

  indexItem(_item: any): Promise<void> {
    // In Library Bounded Context, indexing is handled via FTS in SearchService
    return Promise.resolve();
  }

  reindexItem(_item: any): Promise<{
    localIndexed: boolean;
    error?: string;
  }> {
    return Promise.resolve({ localIndexed: true });
  }
}
