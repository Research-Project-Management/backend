import { Injectable } from '@nestjs/common';
import { SearchService } from './services/search.service';
import { SearchItemsQueryDto } from './dto/search.dto';
import { CatalogItemSummary } from '@/modules/library/core';

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
  indexAttachmentPages?(
    attachmentId: string,
    pages: Array<{ pageIndex: number; textContent: string }>,
  ): Promise<void>;
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
    const result = await this.searchService.search(userId, queryDto);
    return {
      items: result.items as unknown as CatalogItemSummary[],
      facets: result.facets,
      meta: result.meta,
    };
  }

  async indexItem(item: {
    id: string;
    userId?: string;
    projectId?: string;
  }): Promise<void> {
    if (typeof this.searchService.indexItem === 'function') {
      await this.searchService.indexItem(item);
      return;
    }
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
      if (typeof this.searchService.indexItem === 'function') {
        const res = await this.searchService.indexItem(item);
        return { localIndexed: res.indexed };
      }
      await this.indexItem(item);
      return { localIndexed: Boolean(item.id) };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { localIndexed: false, error: errMsg };
    }
  }

  async indexAttachmentPages(
    attachmentId: string,
    pages: Array<{ pageIndex: number; textContent: string }>,
  ): Promise<void> {
    await this.searchService.indexAttachmentPages(attachmentId, pages);
  }
}
