import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ContextService } from './context.service';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Library - Research Context')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class ContextController {
  constructor(private readonly contextService: ContextService) {}

  @Get([
    'workspace/:workspaceId/library/items/:itemId/bundle',
    'workspace/:workspaceId/library/items/:itemId/context',
    'library/:workspaceId/catalog/:itemId/bundle',
    'library/:workspaceId/papers/:itemId/bundle',
    'library/papers/:workspaceId/:itemId/bundle',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary:
      'Get the metadata, citations, annotations, and relations for one library item',
  })
  async getItemResearchContext(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.contextService.getItemResearchContext(workspaceId, itemId);
  }
}

export { ContextController as ResearchContextController };
