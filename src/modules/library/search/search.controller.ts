import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { SearchCatalogQueryDto } from './dto/search.dto';

import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Library - Search')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get(['workspace/:workspaceId/library/search', 'library/search/:workspaceId'])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'Full-text search across catalog items in a workspace',
  })
  async searchCatalog(
    @Param('workspaceId') workspaceId: string,
    @Query() dto: SearchCatalogQueryDto,
  ) {
    return this.searchService.searchCatalog(workspaceId, dto);
  }
}
