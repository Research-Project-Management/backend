import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Optional,
} from '@nestjs/common';
import { DuplicateService } from '@/modules/library/ingestion/services/duplicate.service';
import { QualityService } from '@/modules/library/ingestion/services/quality.service';
import { IngestionService } from '@/modules/library/ingestion/services/ingestion.service';
import { SubsystemUnavailableException } from '@/modules/library/core/errors/domain.exception';
import {
  MergeDuplicatesDto,
  DismissDuplicatesDto,
  ReResolveMetadataDto,
} from '@/modules/library/ingestion/dto/curation.dto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Library Curation')
@ApiBearerAuth()
@Controller([
  'api/v1/library/curation',
  'api/v1/projects/:projectId/library/curation',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class CurationController {
  constructor(
    private readonly duplicateService: DuplicateService,
    private readonly qualityService: QualityService,
    @Optional() private readonly ingestionService?: IngestionService,
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

  @Post('duplicates/dismiss')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async dismissDuplicates(
    @CurrentUser('id') userId: string,
    @Body() dto: DismissDuplicatesDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId =
      paramProjectId || queryProjectId || dto?.projectId;
    return this.duplicateService.dismissDuplicates(
      userId,
      dto.itemIds,
      effectiveProjectId,
    );
  }

  @Get(['quality', 'integrity'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getQualityAudit(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.qualityService.getQualityAudit(userId, effectiveProjectId);
  }

  /**
   * On-demand bibliographic re-resolution against Open Academic Mirrors.
   * User can trigger re-fetch to repair missing DOI, metadata, or author diacritics.
   */
  @Post(['items/:id/re-resolve', ':id/re-resolve'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async reResolveMetadata(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ReResolveMetadataDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!this.ingestionService) {
      throw new SubsystemUnavailableException(
        'IngestionService is not available in CurationController',
        { subsystem: 'IngestionService' },
      );
    }
    const effectiveProjectId =
      paramProjectId || queryProjectId || dto?.projectId;
    return this.ingestionService.reResolveMetadata(
      userId,
      id,
      dto,
      effectiveProjectId,
    );
  }
}
