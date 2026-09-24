import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DuplicateService } from '../application/services/duplicate.service';
import { QualityService } from '../application/services/quality.service';
import {
  MergeDuplicatesDto,
} from '../application/dtos/curation.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@Controller([
  'api/v1/library/curation',
  'api/v1/projects/:projectId/library/curation',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class CurationController {
  constructor(
    private readonly duplicateService: DuplicateService,
    private readonly qualityService: QualityService,
  ) {}

  @Get('duplicates')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getDuplicates(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.duplicateService.detectDuplicates(userId, effectiveProjectId);
  }

  /**
   * Zotero-Compliant Human-in-the-Loop Merge:
   * Merging requires explicit review and confirmation from the user.
   * Automated batch merging has been decommissioned to guarantee 0% data corruption risk.
   */
  @Post('merge')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async mergeDuplicates(
    @CurrentUser('id') userId: string,
    @Body() dto: MergeDuplicatesDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId =
      paramProjectId || queryProjectId || dto.projectId;
    return this.duplicateService.mergeDuplicates(
      userId,
      dto,
      effectiveProjectId,
    );
  }

  @Get(['quality-audit', 'quality', 'integrity'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getQualityAudit(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.qualityService.getQualityAudit(userId, effectiveProjectId);
  }
}
