import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SearchService } from '../application/services/search.service';
import { SearchItemsQueryDto } from '../application/dtos/search.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@Controller([
  'api/v1/library/search',
  'api/v1/projects/:projectId/library/search',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
  ) {}

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
    @Query('term') term: string,
    @Query('pageIndex') pageIndex?: string,
  ) {
    const parsedPage =
      pageIndex !== undefined ? parseInt(pageIndex, 10) : undefined;
    return this.searchService.searchPageAnchors(
      userId,
      attachmentId,
      term,
      parsedPage,
    );
  }
}
