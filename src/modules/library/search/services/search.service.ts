import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import { SearchOptions } from '@/modules/library/search/types/search.types';
import {
  FullTextProvider,
  PageAnchorMatch,
  PageTextExtraction,
} from './full-text.provider';
import { SearchItemsQueryDto } from '@/modules/library/search/dto/search.dto';

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
    const effectiveQuery = dto.query ?? dto.q ?? '';
    const searchOptions: SearchOptions = {
      q: effectiveQuery,
      collectionId: dto.collectionId,
      tagId: dto.tagId,
      limit: dto.limit,
      cursor: dto.cursor,
      projectId: dto.projectId,
      ...(dto.itemType !== undefined ? { itemType: dto.itemType } : {}),
      ...(dto.yearFrom !== undefined ? { yearFrom: dto.yearFrom } : {}),
      ...(dto.yearTo !== undefined ? { yearTo: dto.yearTo } : {}),
      ...(dto.sortBy !== undefined ? { sortBy: dto.sortBy } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
    };

    const [searchResult, facets] = await Promise.all([
      this.repo.searchItems(userId, searchOptions),
      this.repo.computeFacets(userId, searchOptions),
    ]);

    const pageCount = searchResult.items.length;
    const facetSum = Object.values(facets?.itemTypes || {}).reduce(
      (sum, count) => sum + (typeof count === 'number' ? count : 0),
      0,
    );
    const totalCount = Math.max(facetSum, pageCount);

    return {
      items: searchResult.items,
      total: totalCount,
      facets,
      nextCursor: searchResult.nextCursor ?? null,
      meta: {
        cursor: searchResult.nextCursor,
        hasNextPage: searchResult.hasNextPage,
        pageCount,
        totalCount,
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
    projectId?: string,
  ): Promise<PageAnchorMatch[]> {
    const attachment = await this.repo.findAttachmentWithItem(attachmentId);

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    const isProjectScope = Boolean(
      projectId &&
      projectId !== 'user' &&
      projectId !== 'me' &&
      projectId !== 'personal',
    );
    if (isProjectScope) {
      if (attachment.item.projectId !== projectId) {
        throw new NotFoundException(`Attachment ${attachmentId} not found`);
      }
    } else if (attachment.item.userId !== userId || attachment.item.projectId) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (!term || !term.trim()) {
      return [];
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
    if (typeof this.repo.invalidateFacets === 'function') {
      await this.repo.invalidateFacets(userId);
    }
    const facets = await this.repo.computeFacets(userId, {});
    const totalTypes = Object.values(facets.itemTypes).reduce<number>(
      (a: number, b: unknown) => a + Number(b || 0),
      0,
    );
    const indexedAttachments =
      typeof this.repo.countIndexedAttachments === 'function'
        ? await this.repo.countIndexedAttachments(userId)
        : 0;
    this.logger.log(
      `Search index validated for user ${userId}: ${totalTypes} active items, ${indexedAttachments} attachments indexed.`,
    );
    return {
      indexedItems: totalTypes,
      indexedAttachments,
    };
  }

  async invalidateFacetsCache(scopeId: string): Promise<void> {
    await this.repo.invalidateFacets(scopeId);
  }
}
