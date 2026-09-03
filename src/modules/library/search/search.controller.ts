import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchCatalogQueryDto } from './dto/search.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';

@Controller('api/v1/workspaces/:workspaceId/library/search')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async searchCatalog(
    @Param('workspaceId') workspaceId: string,
    @Query() dto: SearchCatalogQueryDto,
  ) {
    return this.searchService.searchCatalog(workspaceId, dto);
  }

  @Get('attachments/:attachmentId/anchors')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async searchAnchors(
    @Param('attachmentId') attachmentId: string,
    @Query('term') term: string,
    @Query('pageIndex') pageIndex?: string,
  ) {
    const parsedPage =
      pageIndex !== undefined ? parseInt(pageIndex, 10) : undefined;
    return this.searchService.searchPageAnchors(attachmentId, term, parsedPage);
  }
}
