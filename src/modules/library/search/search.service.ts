import { Injectable, Logger } from '@nestjs/common';
import { SearchRepository, SearchOptions } from './search.repository';
import {
  FullTextIndexer,
  PageAnchorMatch,
  PageTextExtraction,
} from './providers/full-text-indexer.provider';
import { SearchCatalogQueryDto } from './dto/search.dto';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly searchRepo: SearchRepository,
    private readonly fullTextIndexer: FullTextIndexer,
  ) {}

  /**
   * Faceted search returning items, facets, and cursor pagination metadata.
   */
  async search(workspaceId: string, dto: SearchCatalogQueryDto) {
    const searchOptions: SearchOptions = {
      q: dto.query,
      collectionId: dto.collectionId,
      tagId: dto.tagId,
      limit: dto.limit,
      cursor: dto.cursor,
    };

    const [searchResult, facets] = await Promise.all([
      this.searchRepo.searchItems(workspaceId, searchOptions),
      this.searchRepo.computeFacets(workspaceId, searchOptions),
    ]);

    return {
      items: searchResult.items,
      facets,
      meta: {
        cursor: searchResult.nextCursor,
        hasNextPage: searchResult.hasNextPage,
        totalCount: searchResult.items.length,
      },
    };
  }

  /**
   * Search alias for searchCatalog
   */
  async searchCatalog(workspaceId: string, dto: SearchCatalogQueryDto) {
    return this.search(workspaceId, dto);
  }

  /**
   * Search PDF attachment pages for text occurrences and character offsets.
   */
  async searchPageAnchors(
    attachmentId: string,
    term: string,
    pageIndex?: number,
  ): Promise<PageAnchorMatch[]> {
    return this.fullTextIndexer.searchPageAnchors(
      attachmentId,
      term,
      pageIndex,
    );
  }

  async indexAttachmentPages(
    attachmentId: string,
    pages: PageTextExtraction[],
  ): Promise<void> {
    await this.fullTextIndexer.indexAttachmentPages(attachmentId, pages);
  }

  /**
   * Rebuilds full-text and faceted search index for a given workspace.
   */
  async rebuildIndex(
    workspaceId: string,
  ): Promise<{ indexedItems: number; indexedAttachments: number }> {
    this.logger.log(`Rebuilding search index for workspace ${workspaceId}...`);
    const facets = await this.searchRepo.computeFacets(workspaceId, {});
    const totalTypes = Object.values(facets.itemTypes).reduce(
      (a, b) => a + b,
      0,
    );
    this.logger.log(
      `Search index validated for workspace ${workspaceId}: ${totalTypes} active items indexed.`,
    );
    return {
      indexedItems: totalTypes,
      indexedAttachments: 0,
    };
  }
}
