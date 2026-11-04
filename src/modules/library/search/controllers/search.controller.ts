import { IsString, IsOptional, IsInt, Min, Max, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { Injectable, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { SearchService, type PageAnchorMatch } from '@/modules/library/search/services/search.service';
import { CatalogItemSummary, SEARCH_FACADE, ISearchFacade, type SearchPageTextInput } from '@/modules/library/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';

export interface SearchOptions {
  q?: string;
  searchMode?: 'title_creator_year' | 'fields_tags' | 'everything' | string;
  view?:
    | 'all'
    | 'recent'
    | 'unfiled'
    | 'trash'
    | 'my-publications'
    | 'publications'
    | 'starred'
    | 'retracted'
    | string;
  itemType?: string | string[];
  type?: string;
  collectionId?: string;
  collectionIds?: string[];
  targetCollectionIds?: string[];
  includeSubcollections?: boolean;
  recursive?: boolean;
  tagId?: string;
  tag?: string;
  hasFile?: boolean;
  hasNotes?: boolean;
  isRetracted?: boolean;
  onlyFlagged?: boolean;
  readStatus?: string;
  yearFrom?: number;
  yearTo?: number;
  fromYear?: number;
  toYear?: number;
  sortBy?:
    | 'relevance'
    | 'dateAdded'
    | 'createdAt'
    | 'updatedAt'
    | 'year'
    | 'title'
    | 'authors'
    | 'firstAuthor'
    | 'publication'
    | 'publicationTitle'
    | 'citationKey'
    | string;
  sortOrder?: 'asc' | 'desc';
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
  limit?: number;
  page?: number;
  cursor?: string;
  projectId?: string;
}

export interface FacetResult {
  itemTypes: Record<string, number>;
  years: Record<number, number>;
  tags: Record<string, number>;
  collections?: Record<string, number>;
}

const parseOptionalBoolean = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const str = String(value).trim().toLowerCase();
  if (str === 'true' || str === '1') return true;
  if (str === 'false' || str === '0') return false;
  return undefined;
};

export class SearchItemsQueryDto {
  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  searchMode?: 'title_creator_year' | 'fields_tags' | 'everything' | string;

  @IsOptional()
  @IsString()
  view?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @Transform(parseOptionalBoolean)
  @IsBoolean()
  includeSubcollections?: boolean;

  @IsOptional()
  @IsString()
  tagId?: string;

  @IsOptional()
  @IsString()
  tag?: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  itemType?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  yearFrom?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  yearTo?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  fromYear?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  toYear?: number;

  @IsOptional()
  @Transform(parseOptionalBoolean)
  @IsBoolean()
  hasFile?: boolean;

  @IsOptional()
  @Transform(parseOptionalBoolean)
  @IsBoolean()
  hasNotes?: boolean;

  @IsOptional()
  @IsString()
  readStatus?: string;

  @IsOptional()
  @IsString()
  sortBy?:
    | 'relevance'
    | 'dateAdded'
    | 'createdAt'
    | 'updatedAt'
    | 'year'
    | 'title'
    | 'authors'
    | 'firstAuthor'
    | 'publication'
    | 'publicationTitle'
    | 'citationKey'
    | string;

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  orderBy?: string;

  @IsOptional()
  @IsString()
  orderDirection?: 'asc' | 'desc';

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeFacets?: boolean;
}

export class SearchPageAnchorsQueryDto {
  @IsOptional()
  @IsString()
  term?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  })
  @IsInt()
  @Min(0)
  pageIndex?: number;

  @IsOptional()
  @IsString()
  projectId?: string;
}

export { SEARCH_FACADE };
export type { ISearchFacade };

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

@ApiTags('Library Search')
@ApiBearerAuth()
@Controller([
  'api/v1/library/search',
  'api/v1/projects/:projectId/library/search',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async searchItems(
    @CurrentUser('id') userId: string,
    @Query() dto: SearchItemsQueryDto,
    @Param('projectId') routeProjectId?: string,
  ) {
    if (routeProjectId && !dto.projectId) {
      dto.projectId = routeProjectId;
    }
    return this.searchService.search(userId, dto);
  }

  @Get('attachments/:attachmentId/anchors')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async searchAnchors(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query() queryOrTerm?: SearchPageAnchorsQueryDto | string,
    @Query('pageIndex') rawPageIndex?: string | number,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const isDtoObject =
      queryOrTerm !== null &&
      typeof queryOrTerm === 'object' &&
      !Array.isArray(queryOrTerm);
    const term = isDtoObject
      ? (queryOrTerm.term ?? '')
      : typeof queryOrTerm === 'string'
        ? queryOrTerm
        : '';
    const candidatePage = isDtoObject ? queryOrTerm.pageIndex : rawPageIndex;
    const parsedPage =
      typeof candidatePage === 'number'
        ? Number.isInteger(candidatePage) && candidatePage >= 0
          ? candidatePage
          : undefined
        : candidatePage !== undefined
          ? (() => {
              const p = parseInt(String(candidatePage), 10);
              return Number.isInteger(p) && p >= 0 ? p : undefined;
            })()
          : undefined;
    const effectiveProjectId =
      routeProjectId ||
      (isDtoObject ? queryOrTerm.projectId : undefined) ||
      queryProjectId;

    return this.searchService.searchPageAnchors(
      userId,
      attachmentId,
      term,
      parsedPage,
      effectiveProjectId,
    );
  }
}
