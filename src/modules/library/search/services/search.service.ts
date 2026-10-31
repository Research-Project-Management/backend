import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import {
  SearchOptions,
  FacetResult,
  SearchItemsQueryDto,
} from '@/modules/library/search/dto/search.dto';
import {
  isProjectScopeId,
  SubsystemUnavailableException,
  isSafeSearchRegex,
  parseSafeSearchRegex,
  ItemsMapper,
} from '@/modules/library/core';

export { isSafeSearchRegex, parseSafeSearchRegex };

export interface PageTextExtraction {
  pageIndex: number;
  textContent: string;
  charOffset?: number;
}

export interface PageAnchorMatch {
  attachmentId: string;
  pageIndex: number;
  snippet: string;
  charOffsetStart: number;
  charOffsetEnd: number;
}

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

@Injectable()
export class FullTextProvider {
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
    if (!safeRegex && normalizedTerm.length < 2) return [];

    const MAX_MATCHES_PER_ATTACHMENT = 200;
    const MAX_MATCHES_PER_PAGE = 50;

    const pages = await this.repo.findAttachmentPages(
      attachmentId,
      pageIndex,
      safeRegex ? undefined : normalizedTerm,
    );
    const matches: PageAnchorMatch[] = [];

    for (const page of pages) {
      const textContent = page.textContent || '';
      let pageMatches = 0;

      if (safeRegex) {
        safeRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while (
          (match = safeRegex.exec(textContent)) !== null &&
          matches.length < MAX_MATCHES_PER_ATTACHMENT &&
          pageMatches < MAX_MATCHES_PER_PAGE
        ) {
          const matchedText = match[0] || '';
          if (matchedText.length === 0) {
            safeRegex.lastIndex++;
            continue;
          }
          pageMatches++;
          const pos = match.index;
          const charOffsetStart = (page.charOffset ?? 0) + pos;
          matches.push({
            attachmentId,
            pageIndex: page.pageIndex,
            snippet: buildContextualSnippet(
              textContent,
              pos,
              matchedText.length,
            ),
            charOffsetStart,
            charOffsetEnd: charOffsetStart + matchedText.length,
          });
        }
      } else {
        const lower = textContent.toLowerCase();
        let pos = 0;
        while (
          (pos = lower.indexOf(normalizedTerm, pos)) !== -1 &&
          matches.length < MAX_MATCHES_PER_ATTACHMENT &&
          pageMatches < MAX_MATCHES_PER_PAGE
        ) {
          pageMatches++;
          const charOffsetStart = (page.charOffset ?? 0) + pos;
          matches.push({
            attachmentId,
            pageIndex: page.pageIndex,
            snippet: buildContextualSnippet(
              textContent,
              pos,
              normalizedTerm.length,
            ),
            charOffsetStart,
            charOffsetEnd: charOffsetStart + normalizedTerm.length,
          });
          pos += normalizedTerm.length;
        }
      }

      if (matches.length >= MAX_MATCHES_PER_ATTACHMENT) break;
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
