import { Injectable, Optional } from '@nestjs/common';
import { SearchService } from './core/services/search.service';
import { SearchItemsQueryDto } from './dto/search.dto';

export const SEARCH_FACADE = 'SEARCH_FACADE';

export interface ISearchFacade {
  search(
    userId: string,
    queryDto: SearchItemsQueryDto,
  ): Promise<{
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
  constructor(@Optional() private readonly searchService?: SearchService) {}

  async search(
    userId: string,
    queryDto: SearchItemsQueryDto,
  ): Promise<{
    items: unknown[];
    facets?: unknown;
    meta?: {
      cursor?: string;
      hasNextPage: boolean;
      pageCount: number;
    };
  }> {
    if (!this.searchService)
      return { items: [], meta: { hasNextPage: false, pageCount: 0 } };
    return this.searchService.search(userId, queryDto);
  }

  async indexItem(item: {
    id: string;
    userId?: string;
    projectId?: string;
  }): Promise<void> {
    if (this.searchService) {
      const scopeId = item.projectId || item.userId;
      if (scopeId) {
        await this.searchService.invalidateFacetsCache(scopeId);
      }
    }
  }

  async reindexItem(item: {
    id: string;
    userId?: string;
    projectId?: string;
  }): Promise<{
    localIndexed: boolean;
    error?: string;
  }> {
    if (!this.searchService) return { localIndexed: false };
    try {
      const scopeId = item.projectId || item.userId;
      if (scopeId) {
        await this.searchService.invalidateFacetsCache(scopeId);
      }
      return { localIndexed: true };
    } catch (err: any) {
      return { localIndexed: false, error: err?.message || String(err) };
    }
  }
}
