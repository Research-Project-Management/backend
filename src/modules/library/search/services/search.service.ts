import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import {
  SearchOptions,
  FacetResult,
} from '@/modules/library/search/types/search.types';
import {
  FullTextProvider,
  PageAnchorMatch,
  PageTextExtraction,
} from './full-text.provider';
import { SearchItemsQueryDto } from '@/modules/library/search/dto/search.dto';
import { isProjectScopeId } from '@/modules/library/core';
import { ItemsMapper } from '@/modules/library/catalog';

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

    const [searchResult, facets, directCount] = await Promise.all([
      this.repo.searchItems(userId, searchOptions),
      dto.includeFacets === false
        ? Promise.resolve<FacetResult>({ itemTypes: {}, years: {}, tags: {} })
        : this.repo.computeFacets(userId, searchOptions),
      dto.includeFacets === false && this.repo.countSearchItems
        ? this.repo.countSearchItems(userId, searchOptions)
        : Promise.resolve<number | undefined>(undefined),
    ]);

    const pageCount = searchResult.items.length;
    const facetSum = Object.values(facets?.itemTypes || {}).reduce(
      (sum, count) => sum + (typeof count === 'number' ? count : 0),
      0,
    );
    const totalCount =
      dto.includeFacets === false && typeof directCount === 'number'
        ? Math.max(directCount, pageCount)
        : Math.max(facetSum, pageCount);

    const mappedItems = searchResult.items.map(
      (item) =>
        ItemsMapper.mapFlattenedState(
          item as unknown as Record<string, unknown>,
          userId,
        ) ?? ItemsMapper.toDomain(item),
    );

    return {
      items: mappedItems,
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
    const trimmed = term?.trim();
    if (!trimmed) {
      return [];
    }

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

    return this.fullText.searchPageAnchors(attachmentId, trimmed, pageIndex);
  }

  async indexAttachmentPages(
    attachmentId: string,
    pages: PageTextExtraction[],
  ): Promise<void> {
    await this.fullText.indexAttachmentPages(attachmentId, pages);
  }

  async invalidateFacetsCache(scopeId: string): Promise<void> {
    await this.repo.invalidateFacets(scopeId);
  }

  async indexItem(item: {
    id: string;
    userId?: string;
    projectId?: string;
  }): Promise<{ indexed: boolean }> {
    const scopeId = item.projectId || item.userId;
    if (typeof this.repo.refreshItemSearchIndex === 'function') {
      return this.repo.refreshItemSearchIndex(item.id, scopeId);
    }
    if (scopeId) {
      await this.invalidateFacetsCache(scopeId);
    }
    return { indexed: Boolean(item.id) };
  }
}
