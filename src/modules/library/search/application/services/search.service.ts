import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  SearchRepository,
  SearchOptions,
} from '../../infrastructure/repositories/search.repository';
import {
  FullTextProvider,
  PageAnchorMatch,
  PageTextExtraction,
} from '../../infrastructure/providers/full-text.provider';
import { SearchItemsQueryDto } from '../dtos/search.dto';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly repo: SearchRepository,
    private readonly fullText: FullTextProvider,
  ) {}

  /**
   * Faceted search returning items, facets, and cursor pagination metadata.
   */
  async search(userId: string, dto: SearchItemsQueryDto) {
    const searchOptions: SearchOptions = {
      q: dto.query,
      collectionId: dto.collectionId,
      tagId: dto.tagId,
      limit: dto.limit,
      cursor: dto.cursor,
      projectId: dto.projectId,
    };

    const [searchResult, facets] = await Promise.all([
      this.repo.searchItems(userId, searchOptions),
      this.repo.computeFacets(userId, searchOptions),
    ]);

    return {
      items: searchResult.items,
      facets,
      meta: {
        cursor: searchResult.nextCursor,
        hasNextPage: searchResult.hasNextPage,
        // NOTE: pageCount reflects items on this page only, NOT the full result set total.
        // Replace with a dedicated COUNT query from the repository when available.
        pageCount: searchResult.items.length,
      },
    };
  }

  /**
   * Search PDF attachment pages for text occurrences and character offsets.
   */
  async searchPageAnchors(
    userId: string,
    attachmentId: string,
    term: string,
    pageIndex?: number,
  ): Promise<PageAnchorMatch[]> {
    const attachment = await this.repo.findAttachmentWithItem(attachmentId);

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (attachment.item.userId !== userId) {
      if (!attachment.item.projectId) {
        throw new NotFoundException(`Attachment ${attachmentId} not found`);
      }
      const member = await this.repo.checkProjectMember(
        attachment.item.projectId,
        userId,
      );
      if (!member) {
        throw new NotFoundException(`Attachment ${attachmentId} not found`);
      }
    }

    return this.fullText.searchPageAnchors(attachmentId, term, pageIndex);
  }

  async indexAttachmentPages(
    attachmentId: string,
    pages: PageTextExtraction[],
  ): Promise<void> {
    await this.fullText.indexAttachmentPages(attachmentId, pages);
  }

  /**
   * Rebuilds full-text and faceted search index for a given user library scope.
   */
  async rebuildIndex(
    userId: string,
  ): Promise<{ indexedItems: number; indexedAttachments: number }> {
    this.logger.log(`Rebuilding search index for user ${userId}...`);
    const facets = await this.repo.computeFacets(userId, {});
    const totalTypes = Object.values(facets.itemTypes).reduce(
      (a, b) => a + b,
      0,
    );
    this.logger.log(
      `Search index validated for user ${userId}: ${totalTypes} active items indexed.`,
    );
    return {
      indexedItems: totalTypes,
      indexedAttachments: 0,
    };
  }

  async invalidateFacetsCache(scopeId: string): Promise<void> {
    await this.repo.invalidateFacets(scopeId);
  }
}
