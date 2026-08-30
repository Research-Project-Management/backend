import { Injectable, Logger } from '@nestjs/common';
import { SearchRepository, SearchOptions } from './search.repository';
import {
  FullTextIndexer,
  PageAnchorMatch,
  PageTextExtraction,
} from './providers/full-text-indexer.provider';
import { SearchCatalogQueryDto, SavedSearchDto } from './dto/search.dto';

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
   * Saved search operations
   */
  async createSavedSearch(
    workspaceId: string,
    userId: string,
    dto: SavedSearchDto,
  ) {
    return this.searchRepo.createSavedSearch(workspaceId, userId, {
      name: dto.name,
      query: dto.filters || { q: dto.query },
    });
  }

  async listSavedSearches(workspaceId: string, userId: string) {
    return this.searchRepo.listSavedSearches(workspaceId, userId);
  }

  async deleteSavedSearch(workspaceId: string, userId: string, id: string) {
    return this.searchRepo.deleteSavedSearch(workspaceId, userId, id);
  }
}
