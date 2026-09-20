import { Injectable, Optional } from '@nestjs/common';
import { SearchService } from './application/services/search.service';
import { SemanticSearchService } from './application/services/semantic-search.service';
import { RagProvider } from './infrastructure/providers/rag.provider';

export const SEARCH_FACADE = 'SEARCH_FACADE';

export interface ISearchFacade {
  search(userId: string, queryDto: any): Promise<any>;
  indexItem(item: any): Promise<void>;
  reindexItem(item: any): Promise<{
    localIndexed: boolean;
    docId?: string;
    error?: string;
  }>;
}

@Injectable()
export class SearchFacade implements ISearchFacade {
  constructor(
    @Optional() private readonly searchService?: SearchService,
    @Optional() private readonly semanticSearch?: SemanticSearchService,
    @Optional() private readonly rag?: RagProvider,
  ) {}

  async search(userId: string, queryDto: any): Promise<any> {
    if (!this.searchService) return { items: [], total: 0 };
    return this.searchService.search(userId, queryDto);
  }

  async indexItem(item: any): Promise<void> {
    if (this.semanticSearch) {
      await this.semanticSearch.indexItem(item);
    }
  }

  async reindexItem(item: any): Promise<{
    localIndexed: boolean;
    docId?: string;
    error?: string;
  }> {
    let localIndexed = false;
    let docId: string | undefined;
    let error: string | undefined;

    if (this.semanticSearch) {
      try {
        await this.semanticSearch.indexItem(item);
        localIndexed = true;
      } catch {
        // ignore
      }
    }

    if (this.rag) {
      try {
        const res = await this.rag.indexPaper(item);
        docId = res?.docId;
      } catch (err: any) {
        error = err instanceof Error ? err.message : 'External RAG unavailable';
      }
    } else {
      error = 'RagProvider not configured';
    }

    return { localIndexed, docId, error };
  }
}
