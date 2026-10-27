import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DuplicateDetectorService } from '@/modules/library/ingestion/services/duplicate-detector.service';
import { DuplicateMergerService } from '@/modules/library/ingestion/services/duplicate-merger.service';
import { QualityService } from '@/modules/library/ingestion/services/quality.service';
import {
  MergeDuplicatesDto,
  DismissDuplicatesDto,
  UndoMergeDuplicatesDto,
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
    private readonly duplicateDetector: DuplicateDetectorService,
    private readonly duplicateMerger: DuplicateMergerService,
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
    return this.duplicateDetector.detectDuplicates(userId, effectiveProjectId);
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
    return this.duplicateMerger.mergeDuplicates(
      userId,
      dto,
      effectiveProjectId,
    );
  }

  @Post(['undo-merge', 'duplicates/undo-merge'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async undoMergeDuplicates(
    @CurrentUser('id') userId: string,
    @Body() dto: UndoMergeDuplicatesDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId =
      paramProjectId || queryProjectId || dto?.projectId;
    return this.duplicateMerger.undoMerge(
      userId,
      dto.primaryItemId,
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
    return this.duplicateDetector.dismissDuplicates(
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
}
