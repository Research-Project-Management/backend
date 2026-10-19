import { Injectable } from '@nestjs/common';
import { SearchService } from './services/search.service';
import { SearchItemsQueryDto } from './dto/search.dto';
import { CatalogItemSummary } from '../catalog/catalog.facade';

export const SEARCH_FACADE = 'SEARCH_FACADE';

export interface ISearchFacade {
  search(
    userId: string,
    queryDto: SearchItemsQueryDto,
  ): Promise<{
    items: CatalogItemSummary[];
    facets?: unknown;
    meta?: {
      cursor?: string;
      hasNextPage: boolean;
      pageCount: number;
    };
  }>;
  indexItem(item: {
    id: string;
    userId?: string;
    projectId?: string;
  }): Promise<void>;
  reindexItem(item: {
    id: string;
    userId?: string;
    projectId?: string;
  }): Promise<{
    localIndexed: boolean;
    error?: string;
  }>;
}

@Injectable()
export class SearchFacade implements ISearchFacade {
  constructor(private readonly searchService: SearchService) {}

  async search(
    userId: string,
    queryDto: SearchItemsQueryDto,
  ): Promise<{
    items: CatalogItemSummary[];
    facets?: unknown;
    meta?: {
      cursor?: string;
      hasNextPage: boolean;
      pageCount: number;
    };
  }> {
    return this.searchService.search(userId, queryDto);
  }

  async indexItem(item: {
    id: string;
    userId?: string;
    projectId?: string;
  }): Promise<void> {
    const scopeId = item.projectId || item.userId;
    if (scopeId) {
      await this.searchService.invalidateFacetsCache(scopeId);
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
    try {
      await this.indexItem(item);
      return { localIndexed: true };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { localIndexed: false, error: errMsg };
    }
  }
}
