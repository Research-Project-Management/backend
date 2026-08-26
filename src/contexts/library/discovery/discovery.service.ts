import { Injectable, Logger } from '@nestjs/common';
import {
  DiscoveryRepository,
  DiscoverySearchOptions,
} from './discovery.repository';
import { FullTextIndexer, PageAnchorMatch } from './full-text-indexer';
import { SearchDiscoveryDto, CreateSavedSearchDto } from './dto/discovery.dto';

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    private readonly discoveryRepo: DiscoveryRepository,
    private readonly fullTextIndexer: FullTextIndexer,
  ) {}

  /**
   * Faceted search returning items, facets, and cursor pagination metadata.
   */
  async search(workspaceId: string, dto: SearchDiscoveryDto) {
    const searchOptions: DiscoverySearchOptions = {
      q: dto.q,
      itemType: dto.itemType,
      collectionId: dto.collectionId,
      tagId: dto.tagId,
      yearFrom: dto.yearFrom,
      yearTo: dto.yearTo,
      sortBy: dto.sortBy,
      sortOrder: dto.sortOrder,
      limit: dto.limit,
      cursor: dto.cursor,
    };

    const [searchResult, facets] = await Promise.all([
      this.discoveryRepo.searchItems(workspaceId, searchOptions),
      this.discoveryRepo.computeFacets(workspaceId, searchOptions),
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

  /**
   * Saved search operations
   */
  async createSavedSearch(
    workspaceId: string,
    userId: string,
    dto: CreateSavedSearchDto,
  ) {
    return this.discoveryRepo.createSavedSearch(workspaceId, userId, dto);
  }

  async listSavedSearches(workspaceId: string, userId: string) {
    return this.discoveryRepo.listSavedSearches(workspaceId, userId);
  }

  async deleteSavedSearch(workspaceId: string, userId: string, id: string) {
    return this.discoveryRepo.deleteSavedSearch(workspaceId, userId, id);
  }
}
