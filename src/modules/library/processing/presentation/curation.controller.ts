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
import { MergeDuplicatesDto, AutoResolveClusterDto } from '../application/dtos/curation.dto';
import { JwtAuthGuard } from '../../../iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '../../../iam/authz/guards/role.guard';
import { ProjectRoles } from '../../../iam/authz/decorators/role.decorator';

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

  @Post('duplicates/auto-resolve')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async autoResolveCluster(
    @CurrentUser('id') userId: string,
    @Body() dto: AutoResolveClusterDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId =
      paramProjectId || queryProjectId || dto.projectId;
    return this.duplicateService.autoResolveCluster(
      userId,
      dto.clusterId,
      dto.strategy ?? 'most_complete',
      effectiveProjectId,
    );
  }

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
