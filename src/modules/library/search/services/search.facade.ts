import { Injectable } from '@nestjs/common';
import {
  CatalogItemSummary,
  SEARCH_FACADE,
  ISearchFacade,
  type SearchPageTextInput,
} from '@/modules/library/core';
import { SearchItemsQueryDto } from '@/modules/library/search/dto/search-items.dto';
import type {
  SearchOptions,
  FacetResult,
  PageAnchorMatch,
} from '@/modules/library/search/types/search.types';
import { SearchService } from './search.service';

export { SEARCH_FACADE };
export type { ISearchFacade, SearchOptions, FacetResult };

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
      totalCount?: number;
    };
  }> {
    const result = await this.searchService.search(userId, queryDto);
    return {
      items: result.items as unknown as CatalogItemSummary[],
      facets: result.facets,
      meta: result.meta,
    };
  }

  async searchPageAnchors(
    userId: string,
    attachmentId: string,
    term: string,
    pageIndex?: number,
    projectId?: string,
  ): Promise<PageAnchorMatch[]> {
    return this.searchService.searchPageAnchors(
      userId,
      attachmentId,
      term,
      pageIndex,
      projectId,
    );
  }

  async indexItem(item: {
    id: string;
    userId?: string;
    projectId?: string;
  }): Promise<void> {
    await this.searchService.indexItem(item);
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
      const res = await this.searchService.indexItem(item);
      return { localIndexed: res.indexed };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { localIndexed: false, error: errMsg };
    }
  }

  async indexAttachmentPages(
    attachmentId: string,
    pages: SearchPageTextInput[],
  ): Promise<void> {
    await this.searchService.indexAttachmentPages(attachmentId, pages);
  }

  async removeItemIndex(itemId: string): Promise<void> {
    await this.searchService.deleteItemSearchIndex(itemId);
  }

  async removeAttachmentIndex(attachmentId: string): Promise<void> {
    await this.searchService.deleteAttachmentSearchIndex(attachmentId);
  }

  async invalidateScopeCache(spaceId: string): Promise<void> {
    await this.searchService.invalidateFacetsCache(spaceId);
  }
}
