import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import {
  SearchItemsQueryDto,
  SearchPageAnchorsQueryDto,
} from '@/modules/library/search/dto/search-items.dto';
import type {
  SearchOptions,
  FacetResult,
  PageTextExtraction,
  PageAnchorMatch,
} from '@/modules/library/search/types/search.types';
import { isProjectScopeId, isSafeSearchRegex, parseSafeSearchRegex, SearchQueryEngine, ItemsMapper, SubsystemUnavailableException, LIBRARY_EVENT_TYPES, DomainEventEnvelope, CatalogItemSummary, SEARCH_FACADE, ISearchFacade, type SearchPageTextInput } from '@/modules/library/core';
import { OnEvent } from '@nestjs/event-emitter';

export {
  isSafeSearchRegex,
  parseSafeSearchRegex,
  SEARCH_FACADE,
  SearchItemsQueryDto,
  SearchPageAnchorsQueryDto,
};
export type { ISearchFacade, SearchOptions, FacetResult, PageAnchorMatch };

function buildContextualSnippet(
  textContent: string,
  pos: number,
  matchLen: number,
): string {
  const snippetStart = Math.max(0, pos - 60);
  const snippetEnd = Math.min(textContent.length, pos + matchLen + 60);
  return textContent
    .substring(snippetStart, snippetEnd)
    .replace(/\s+/g, ' ')
    .trim();
}

function createPageAnchorMatch(
  attachmentId: string,
  page: { pageIndex: number; textContent: string; charOffset?: number },
  matchPos: number,
  matchLen: number,
): PageAnchorMatch {
  const charOffsetStart = (page.charOffset ?? 0) + matchPos;
  const charOffsetEnd = charOffsetStart + matchLen;
  const snippet = buildContextualSnippet(page.textContent, matchPos, matchLen);
  return {
    attachmentId,
    pageIndex: page.pageIndex,
    snippet,
    charOffsetStart,
    charOffsetEnd,
    text: snippet,
    startOffset: charOffsetStart,
    endOffset: charOffsetEnd,
  };
}

@Injectable()
export class FullTextProvider {
  private static readonly MAX_MATCHES_PER_ATTACHMENT = 200;
  private static readonly MAX_MATCHES_PER_PAGE = 50;
  private readonly repo: SearchRepository;

  constructor(@Optional() private readonly searchRepo?: SearchRepository) {
    if (!this.searchRepo) {
      throw new SubsystemUnavailableException(
        'FullTextProvider requires SearchRepository',
        { service: 'SearchIndex' },
      );
    }
    this.repo = this.searchRepo;
  }

  async indexAttachmentPages(
    attachmentId: string,
    pages: PageTextExtraction[],
  ): Promise<void> {
    await this.repo.replaceAttachmentPageIndex(attachmentId, pages);
  }

  async searchPageAnchors(
    attachmentId: string,
    term: string,
    pageIndex?: number,
  ): Promise<PageAnchorMatch[]> {
    const trimmedTerm = (term ?? '').trim();
    const safeRegex = parseSafeSearchRegex(trimmedTerm);
    const normalizedTerm = trimmedTerm.toLowerCase();
    const foldedTerm = SearchQueryEngine.stripDiacritics(normalizedTerm);
    if (!safeRegex && normalizedTerm.length < 2) return [];

    const pages = await this.repo.findAttachmentPages(
      attachmentId,
      pageIndex,
      safeRegex ? undefined : normalizedTerm,
    );
    const matches: PageAnchorMatch[] = [];
    const scanStartTime = Date.now();
    const MAX_REGEX_SCAN_TIME_MS = 250;

    for (const page of pages) {
      if (safeRegex && Date.now() - scanStartTime > MAX_REGEX_SCAN_TIME_MS) {
        break;
      }
      const textContent = (page.textContent || '').slice(0, 100_000);
      let pageMatches = 0;

      if (safeRegex) {
        safeRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while (
          (match = safeRegex.exec(textContent)) !== null &&
          matches.length < FullTextProvider.MAX_MATCHES_PER_ATTACHMENT &&
          pageMatches < FullTextProvider.MAX_MATCHES_PER_PAGE
        ) {
          if (Date.now() - scanStartTime > MAX_REGEX_SCAN_TIME_MS) {
            break;
          }
          const matchedText = match[0] || '';
          if (matchedText.length === 0) {
            safeRegex.lastIndex++;
            continue;
          }
          pageMatches++;
          matches.push(
            createPageAnchorMatch(
              attachmentId,
              page,
              match.index,
              matchedText.length,
            ),
          );
        }
      } else {
        const lower = textContent.toLowerCase();
        let pos = 0;
        while (
          (pos = lower.indexOf(normalizedTerm, pos)) !== -1 &&
          matches.length < FullTextProvider.MAX_MATCHES_PER_ATTACHMENT &&
          pageMatches < FullTextProvider.MAX_MATCHES_PER_PAGE
        ) {
          pageMatches++;
          matches.push(
            createPageAnchorMatch(
              attachmentId,
              page,
              pos,
              normalizedTerm.length,
            ),
          );
          pos += normalizedTerm.length;
        }

        // Diacritic-insensitive fallback on the page if exact lowercase had no hits
        if (pageMatches === 0 && foldedTerm.length >= 2) {
          let foldedText = '';
          const foldedToRawIdx: number[] = [];
          for (let i = 0; i < lower.length; i++) {
            const chFolded = SearchQueryEngine.stripDiacritics(lower[i]);
            for (let j = 0; j < chFolded.length; j++) {
              foldedToRawIdx.push(i);
            }
            foldedText += chFolded;
          }
          foldedToRawIdx.push(lower.length);

          let fPos = 0;
          while (
            (fPos = foldedText.indexOf(foldedTerm, fPos)) !== -1 &&
            matches.length < FullTextProvider.MAX_MATCHES_PER_ATTACHMENT &&
            pageMatches < FullTextProvider.MAX_MATCHES_PER_PAGE
          ) {
            pageMatches++;
            const rawStart = foldedToRawIdx[fPos] ?? fPos;
            const rawEnd =
              foldedToRawIdx[fPos + foldedTerm.length] ??
              rawStart + foldedTerm.length;
            matches.push(
              createPageAnchorMatch(
                attachmentId,
                page,
                rawStart,
                Math.max(1, rawEnd - rawStart),
              ),
            );
            fPos += foldedTerm.length;
          }
        }
      }

      if (matches.length >= FullTextProvider.MAX_MATCHES_PER_ATTACHMENT) break;
    }

    return matches;
  }
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly fullText: FullTextProvider;

  constructor(
    private readonly repo: SearchRepository,
    @Optional() fullText?: FullTextProvider,
  ) {
    this.fullText = fullText ?? new FullTextProvider(this.repo);
  }

  /**
   * Faceted search returning items, facets, and cursor pagination metadata.
   */
  async search(userId: string, dto: SearchItemsQueryDto) {
    const effectiveQuery = dto.query ?? dto.q ?? '';
    const effectiveItemType = dto.itemType ?? dto.type;
    const effectiveYearFrom = dto.yearFrom ?? dto.fromYear;
    const effectiveYearTo = dto.yearTo ?? dto.toYear;
    const effectiveSortBy = dto.sortBy ?? dto.orderBy;
    const effectiveSortOrder = dto.sortOrder ?? dto.orderDirection;

    let searchOptions: SearchOptions = {
      q: effectiveQuery,
      collectionId: dto.collectionId,
      tagId: dto.tagId,
      limit: dto.limit,
      cursor: dto.cursor,
      projectId: dto.projectId,
      ...(dto.searchMode !== undefined ? { searchMode: dto.searchMode } : {}),
      ...(dto.view !== undefined ? { view: dto.view } : {}),
      ...(dto.includeSubcollections !== undefined
        ? { includeSubcollections: dto.includeSubcollections }
        : {}),
      ...(dto.tag !== undefined ? { tag: dto.tag } : {}),
      ...(dto.hasFile !== undefined ? { hasFile: dto.hasFile } : {}),
      ...(dto.hasNotes !== undefined ? { hasNotes: dto.hasNotes } : {}),
      ...(dto.readStatus !== undefined ? { readStatus: dto.readStatus } : {}),
      ...(dto.page !== undefined ? { page: dto.page } : {}),
      ...(effectiveItemType !== undefined
        ? { itemType: effectiveItemType }
        : {}),
      ...(effectiveYearFrom !== undefined
        ? { yearFrom: effectiveYearFrom }
        : {}),
      ...(effectiveYearTo !== undefined ? { yearTo: effectiveYearTo } : {}),
      ...(effectiveSortBy !== undefined ? { sortBy: effectiveSortBy } : {}),
      ...(effectiveSortOrder !== undefined
        ? { sortOrder: effectiveSortOrder }
        : {}),
    };

    if (typeof this.repo.prepareSearchOptions === 'function') {
      searchOptions = await this.repo.prepareSearchOptions(
        userId,
        searchOptions,
      );
    }

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
    const ownerItem = attachment?.item as
      | { spaceId?: string; createdById?: string; userId?: string; projectId?: string | null }
      | undefined;
    const isAuthorized = Boolean(
      ownerItem &&
        (isProjectScopeId(projectId)
          ? (ownerItem.projectId ?? ownerItem.spaceId) === projectId.trim()
          : ownerItem.spaceId
            ? ownerItem.spaceId === userId
            : ownerItem.userId === userId && !ownerItem.projectId),
    );
    if (!isAuthorized) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    return this.fullText.searchPageAnchors(attachmentId, trimmed, pageIndex);
  }

  async indexAttachmentPages(
    attachmentId: string,
    pages: PageTextExtraction[],
  ): Promise<void> {
    if (!attachmentId || !Array.isArray(pages) || pages.length === 0) return;
    await this.repo.replaceAttachmentPageIndex(attachmentId, pages);
  }

  async deleteItemSearchIndex(itemId: string): Promise<void> {
    if (!itemId) return;
    await this.repo.deleteFullTextIndexByItemId(itemId);
  }

  async deleteAttachmentSearchIndex(attachmentId: string): Promise<void> {
    if (!attachmentId) return;
    await this.repo.deleteFullTextIndexByAttachmentId(attachmentId);
  }

  async invalidateFacetsCache(scopeId: string): Promise<void> {
    if (!scopeId) return;
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

/**
 * Unified SearchEventsSubscriber for Search Bounded Context.
 * Coordinates full-text index cleanup and Redis search/facet cache invalidations
 * across domain events.
 */
@Injectable()
export class SearchEventsSubscriber {
  private readonly logger = new Logger(SearchEventsSubscriber.name);

  constructor(
    private readonly searchService: SearchService,
    @Optional()
    private readonly searchRepo?: SearchRepository,
  ) {}

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_CREATED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_UPDATED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_RESTORED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_REINDEXED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_MERGED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_TAGGED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_UNTAGGED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_INGESTED_URL, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_INGESTED_DOI, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_INGESTED_BIBTEX, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.NOTE_CREATED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.NOTE_UPDATED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.NOTE_DELETED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ANNOTATION_CREATED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ANNOTATION_UPDATED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ANNOTATION_DELETED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ATTACHMENT_CREATED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ATTACHMENT_UPDATED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ATTACHMENT_DELETED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.TAG_UPDATED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.TAG_DELETED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.COLLECTION_UPDATED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.COLLECTION_DELETED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.COLLECTION_ITEM_ADDED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.COLLECTION_ITEM_REMOVED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.COLLECTION_ITEMS_ASSIGNED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.COLLECTION_ITEMS_DETACHED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.READING_STATE_UPDATED, { async: true })
  async handleItemChanged(event: DomainEventEnvelope): Promise<void> {
    const payload = event?.payload as
      | {
          id?: string;
          attachmentId?: string;
          itemId?: string;
          pages?: PageTextExtraction[];
        }
      | undefined;

    if (payload?.attachmentId && Array.isArray(payload.pages)) {
      try {
        await this.searchService.indexAttachmentPages(
          payload.attachmentId,
          payload.pages,
        );
      } catch (err: unknown) {
        this.logger.error(
          `[SearchEvents] Failed to index attachment pages on ${event.eventType} for ${payload.attachmentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const resolvedItemId =
      payload?.itemId || payload?.id || event?.aggregateId;
    const scopeId = this.resolveScopeId(event);
    let cacheAlreadyInvalidated = false;

    if (resolvedItemId && typeof this.searchService?.indexItem === 'function') {
      try {
        await this.searchService.indexItem({
          id: resolvedItemId,
          projectId: scopeId,
        });
        cacheAlreadyInvalidated = true;
      } catch (err: unknown) {
        this.logger.warn(
          `[SearchEvents] Failed to refresh search_vector on ${event.eventType} for ${resolvedItemId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!scopeId || cacheAlreadyInvalidated) return;

    try {
      await this.searchService?.invalidateFacetsCache?.(scopeId);
    } catch (err: unknown) {
      this.logger.warn(
        `[SearchEvents] Failed to invalidate facet cache on ${event.eventType}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ATTACHMENT_PAGES_EXTRACTED, { async: true })
  async handleAttachmentPagesExtracted(
    event:
      | DomainEventEnvelope<{
          attachmentId?: string;
          itemId?: string;
          pages?: PageTextExtraction[];
        }>
      | {
          attachmentId?: string;
          itemId?: string;
          pages?: PageTextExtraction[];
        },
  ): Promise<void> {
    const rawPayload =
      event &&
      'payload' in event &&
      event.payload &&
      typeof event.payload === 'object'
        ? event.payload
        : (event as {
            attachmentId?: string;
            itemId?: string;
            pages?: PageTextExtraction[];
          });
    const attachmentId =
      rawPayload?.attachmentId ||
      (event && 'aggregateId' in event ? event.aggregateId : undefined);
    const pages = Array.isArray(rawPayload?.pages) ? rawPayload.pages : [];
    if (pages.length === 0) return;

    if (!attachmentId) return;

    try {
      await this.searchService.indexAttachmentPages(
        attachmentId,
        rawPayload?.itemId
          ? pages.map((p) => ({ ...p, itemId: p.itemId ?? rawPayload.itemId }))
          : pages,
      );
    } catch (err: unknown) {
      this.logger.error(
        `[SearchEvents] Failed to index extracted pages for attachment ${attachmentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_DELETED, { async: true })
  async handleItemDeleted(event: DomainEventEnvelope): Promise<void> {
    const scopeId = this.resolveScopeId(event);
    if (!scopeId || !this.searchService?.invalidateFacetsCache) return;

    try {
      await this.searchService.invalidateFacetsCache(scopeId);
    } catch (err: unknown) {
      this.logger.warn(
        `[SearchEvents] Facet cache invalidation error on ITEM_DELETED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_PURGED, { async: true })
  async handleItemPurged(event: DomainEventEnvelope): Promise<void> {
    const payload = event?.payload as
      | {
          id?: string;
          itemId?: string;
          reason?: string;
          mergedIntoId?: string;
          primaryId?: string;
        }
      | undefined;
    const itemId = event?.aggregateId || payload?.id || payload?.itemId;
    if (!itemId) return;

    const isMergedDuplicate = Boolean(
      payload?.reason === 'merged_into' ||
      payload?.mergedIntoId ||
      payload?.primaryId,
    );

    const cleanupTasks: Promise<unknown>[] = [];
    if (!isMergedDuplicate) {
      if (typeof this.searchService?.deleteItemSearchIndex === 'function') {
        cleanupTasks.push(
          this.searchService
            .deleteItemSearchIndex(itemId)
            .catch((err: unknown) =>
              this.logger.error(
                `[SearchEvents] FTS cleanup error for item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            ),
        );
      } else if (this.searchRepo?.deleteFullTextIndexByItemId) {
        cleanupTasks.push(
          this.searchRepo
            .deleteFullTextIndexByItemId(itemId)
            .catch((err: unknown) =>
              this.logger.error(
                `[SearchEvents] FTS cleanup error for item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            ),
        );
      }
    }

    const scopeId = this.resolveScopeId(event);
    if (scopeId && this.searchService?.invalidateFacetsCache) {
      cleanupTasks.push(
        this.searchService
          .invalidateFacetsCache(scopeId)
          .catch((err: unknown) =>
            this.logger.warn(
              `[SearchEvents] Facet cache invalidation error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          ),
      );
    }

    await Promise.allSettled(cleanupTasks);
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ATTACHMENT_DELETED, { async: true })
  async handleDomainAttachmentDeleted(
    event: DomainEventEnvelope,
  ): Promise<void> {
    const attachmentId = event.aggregateId;
    if (!attachmentId) return;

    this.logger.debug(
      `[SearchEvents] Cleaning up FTS index for deleted attachment ${attachmentId}`,
    );
    try {
      if (typeof this.searchService?.deleteAttachmentSearchIndex === 'function') {
        await this.searchService.deleteAttachmentSearchIndex(attachmentId);
      } else if (this.searchRepo?.deleteFullTextIndexByAttachmentId) {
        await this.searchRepo.deleteFullTextIndexByAttachmentId(attachmentId);
      }
    } catch (err: unknown) {
      this.logger.error(
        `[SearchEvents] Attachment FTS cleanup failed for ${attachmentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private resolveScopeId(event: DomainEventEnvelope): string | undefined {
    const payload = event?.payload as
      { projectId?: string | null; userId?: string } | undefined;
    return (
      event?.scopeId ||
      event?.projectId ||
      payload?.projectId ||
      event?.userId ||
      payload?.userId
    );
  }
}

@Injectable()
export class SearchFacade implements ISearchFacade {
  constructor(private readonly searchService: SearchService) {}

  async search(
    userId: string,
    queryDto: SearchItemsQueryDto,
  ): Promise<{
    items: CatalogItemSummary[];
    facets?: unknown;
    meta?: {
      cursor?: string;
      hasNextPage: boolean;
      pageCount: number;
      totalCount?: number;
    };
  }> {
    const result = await this.searchService.search(userId, queryDto);
    return {
      items: result.items as unknown as CatalogItemSummary[],
      facets: result.facets,
      meta: result.meta,
    };
  }

  async searchPageAnchors(
    userId: string,
    attachmentId: string,
    term: string,
    pageIndex?: number,
    projectId?: string,
  ): Promise<PageAnchorMatch[]> {
    return this.searchService.searchPageAnchors(
      userId,
      attachmentId,
      term,
      pageIndex,
      projectId,
    );
  }

  async indexItem(item: {
    id: string;
    userId?: string;
    projectId?: string;
  }): Promise<void> {
    await this.searchService.indexItem(item);
  }

  async reindexItem(item: {
    id: string;
    userId?: string;
    projectId?: string;
  }): Promise<{
    localIndexed: boolean;
    error?: string;
  }> {
    try {
      const res = await this.searchService.indexItem(item);
      return { localIndexed: res.indexed };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { localIndexed: false, error: errMsg };
    }
  }

  async indexAttachmentPages(
    attachmentId: string,
    pages: SearchPageTextInput[],
  ): Promise<void> {
    await this.searchService.indexAttachmentPages(attachmentId, pages);
  }

  async removeItemIndex(itemId: string): Promise<void> {
    await this.searchService.deleteItemSearchIndex(itemId);
  }

  async removeAttachmentIndex(attachmentId: string): Promise<void> {
    await this.searchService.deleteAttachmentSearchIndex(attachmentId);
  }

  async invalidateScopeCache(scopeId: string): Promise<void> {
    await this.searchService.invalidateFacetsCache(scopeId);
  }
}
