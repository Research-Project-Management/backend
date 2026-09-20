import { Injectable, Optional } from '@nestjs/common';
import { SearchService } from './application/services/search.service';
import { CitationService } from './application/services/citation.service';
import { ExportsService } from './application/services/exports.service';
import { SemanticSearchService } from './application/services/semantic-search.service';
import { RagProvider } from './infrastructure/providers/rag.provider';

export const DISCOVERY_FACADE = 'DISCOVERY_FACADE';

export interface IDiscoveryFacade {
  search(userId: string, queryDto: any): Promise<any>;
  formatCitation(
    userId: string,
    itemId: string,
    styleId?: string,
  ): Promise<any>;
  exportBibliography(
    userId: string,
    citeKeys: string[],
  ): Promise<{ content: string } | null>;
  exportLibrary(userId: string, options?: any): Promise<any>;
  indexItem(item: any): Promise<void>;
}

/**
 * Public Facade for Discovery Bounded Context (Generic Domain).
 * Shields search indexing, citation styling engines, and export formats.
 */
@Injectable()
export class DiscoveryFacade implements IDiscoveryFacade {
  constructor(
    @Optional() private readonly searchService?: SearchService,
    @Optional() private readonly citationService?: CitationService,
    @Optional() private readonly exportsService?: ExportsService,
    @Optional() private readonly semanticSearch?: SemanticSearchService,
    @Optional() private readonly rag?: RagProvider,
  ) {}

  async search(userId: string, queryDto: any): Promise<any> {
    if (!this.searchService) return { items: [], total: 0 };
    return this.searchService.search(userId, queryDto);
  }

  async formatCitation(
    userId: string,
    itemId: string,
    styleId = 'apa',
  ): Promise<any> {
    if (!this.citationService) return null;
    return this.citationService.formatItemById(userId, itemId, styleId as any);
  }

  async exportBibliography(
    userId: string,
    citeKeys: string[],
  ): Promise<{ content: string } | null> {
    if (!this.exportsService) return null;
    const res = await this.exportsService.exportByCitationKeys(
      userId,
      citeKeys,
    );
    if (!res || !res.content) return null;
    return { content: res.content };
  }

  async exportLibrary(userId: string, options?: any): Promise<any> {
    if (!this.exportsService) return null;
    return this.exportsService.exportLibrary(userId, options);
  }

  async indexItem(item: any): Promise<void> {
    if (!this.semanticSearch) return;
    await this.semanticSearch.indexItem(item);
  }
}

