import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CatalogService } from './catalog.service';
import { MergeDuplicatesDto } from './dto/curation.dto';

/**
 * Backward-compatible Curation & Quality routes bound to Catalog capability.
 */
@Controller([
  'api/v1/workspaces/:workspaceId/library/curation',
  'api/library/quality/:workspaceId',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CatalogCurationController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('duplicates')
  async getDuplicates(@Param('workspaceId') workspaceId: string) {
    return this.catalogService.detectDuplicates(workspaceId);
  }

  @Post('merge')
  async mergeDuplicates(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: MergeDuplicatesDto,
  ) {
    return this.catalogService.mergeDuplicates(workspaceId, dto);
  }

  @Get(['quality-audit', 'integrity'])
  async getQualityAudit(@Param('workspaceId') workspaceId: string) {
    return this.catalogService.getQualityAudit(workspaceId);
  }
}
