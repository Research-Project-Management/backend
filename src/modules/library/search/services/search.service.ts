import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import { SearchOptions } from '@/modules/library/search/types/search.types';
import {
  FullTextProvider,
  PageAnchorMatch,
  PageTextExtraction,
} from './full-text.provider';
import { SearchItemsQueryDto } from '@/modules/library/search/dto/search.dto';
import { isProjectScopeId } from '@/modules/library/core';

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
    const effectiveQuery = dto.query ?? '';
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

    if (isProjectScopeId(projectId)) {
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
    itemIdOrPages: string | PageTextExtraction[],
    maybePages?: PageTextExtraction[],
  ): Promise<void> {
    const pages = Array.isArray(itemIdOrPages)
      ? itemIdOrPages
      : (maybePages ?? []);
    await this.fullText.indexAttachmentPages(attachmentId, pages);
  }

  async invalidateFacetsCache(scopeId: string): Promise<void> {
    await this.repo.invalidateFacets(scopeId);
  }
}
