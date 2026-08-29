import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchCatalogQueryDto, SavedSearchDto } from './dto/search.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';

@Controller([
  'api/v1/workspaces/:workspaceId/library/search',
  'api/workspace/:workspaceId/library/search',
  'api/library/search/:workspaceId',
  'api/library/papers/:workspaceId/search',
])
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
    return this.searchService.searchPageAnchors(
      attachmentId,
      term,
      parsedPage,
    );
  }

  @Get('saved')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async listSavedSearches(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.searchService.listSavedSearches(workspaceId, userId);
  }

  @Post('saved')
  @WorkspaceRoles('owner', 'admin', 'member')
  async createSavedSearch(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: SavedSearchDto,
  ) {
    return this.searchService.createSavedSearch(workspaceId, userId, dto);
  }

  @Delete('saved/:id')
  @WorkspaceRoles('owner', 'admin', 'member')
  async deleteSavedSearch(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.searchService.deleteSavedSearch(workspaceId, userId, id);
  }
}
