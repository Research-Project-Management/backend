import { CatalogItemSummary } from './catalog.port';

export const SEARCH_FACADE = 'SEARCH_FACADE';

export interface ISearchFacade {
  search(
    userId: string,
    queryDto: Record<string, unknown>,
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
    pages: Array<{
      pageIndex: number;
      textContent: string;
      charOffset?: number;
    }>,
  ): Promise<void>;
}
