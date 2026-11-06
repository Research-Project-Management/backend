import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  SearchService,
  SearchFacade,
  SEARCH_FACADE,
  SearchItemsQueryDto,
  SearchPageAnchorsQueryDto,
  type ISearchFacade,
  type SearchOptions,
  type FacetResult,
} from '@/modules/library/search/services/search.service';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';

export {
  SearchFacade,
  SEARCH_FACADE,
  SearchItemsQueryDto,
  SearchPageAnchorsQueryDto,
};
export type { ISearchFacade, SearchOptions, FacetResult };

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
