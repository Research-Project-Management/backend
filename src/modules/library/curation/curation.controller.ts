import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { DuplicateService } from './services/duplicate.service';
import { QualityService } from './services/quality.service';
import { MergeDuplicatesDto } from './dto/curation.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';

@Controller([
  'api/v1/workspaces/:workspaceId/library/curation',
  'api/v1/workspace/:workspaceId/library/curation',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CurationController {
  constructor(
    private readonly duplicateService: DuplicateService,
    private readonly qualityService: QualityService,
  ) {}

  @Get('duplicates')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getDuplicates(@Param('workspaceId') workspaceId: string) {
    return this.duplicateService.detectDuplicates(workspaceId);
  }

  @Post('merge')
  @WorkspaceRoles('owner', 'admin')
  async mergeDuplicates(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: MergeDuplicatesDto,
  ) {
    return this.duplicateService.mergeDuplicates(workspaceId, dto);
  }

  @Get(['quality-audit', 'quality', 'integrity'])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getQualityAudit(@Param('workspaceId') workspaceId: string) {
    return this.qualityService.getQualityAudit(workspaceId);
  }
}
