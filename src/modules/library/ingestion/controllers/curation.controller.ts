import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import {
  MergeDuplicatesDto,
  BatchMergeDuplicatesDto,
  DismissDuplicatesDto,
  UpdateReviewCaseStatusDto,
} from '@/modules/library/ingestion/dto/curation.dto';
import { IngestionService } from '@/modules/library/ingestion/services/ingestion.service';
import { DuplicateDetectorService } from '@/modules/library/ingestion/services/duplicate-detector.service';
import { DuplicateMergerService } from '@/modules/library/ingestion/services/duplicate-merger.service';
import { QualityService } from '@/modules/library/ingestion/services/ingestion-verifier.service';

@ApiTags('Library Curation')
@ApiBearerAuth()
@Controller([
  'api/v1/library/curation',
  'api/v1/spaces/:spaceId/library/curation',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class CurationController {
  constructor(
    private readonly duplicateDetector: DuplicateDetectorService,
    private readonly duplicateMerger: DuplicateMergerService,
    private readonly qualityService: QualityService,
    @Optional() private readonly ingestionService?: IngestionService,
  ) {}

  @Get('duplicates')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getDuplicates(
    @CurrentUser('id') userId: string,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.duplicateDetector.detectDuplicates(userId, effectiveProjectId);
  }

  @Post('merge')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async mergeDuplicates(
    @CurrentUser('id') userId: string,
    @Body() dto: MergeDuplicatesDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId || dto.spaceId;
    return this.duplicateMerger.mergeDuplicates(
      userId,
      dto,
      effectiveProjectId,
    );
  }

  @Post('merge-batch')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async mergeDuplicatesBatch(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchMergeDuplicatesDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId || dto?.spaceId;
    return this.duplicateMerger.mergeDuplicatesBatch(
      userId,
      dto?.merges || [],
      effectiveProjectId,
    );
  }

  @Post('duplicates/dismiss')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async dismissDuplicates(
    @CurrentUser('id') userId: string,
    @Body() dto: DismissDuplicatesDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId || dto?.spaceId;
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
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.qualityService.getQualityAudit(userId, effectiveProjectId);
  }

  @Get('review-cases')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getReviewCases(
    @CurrentUser('id') userId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    if (!this.ingestionService) {
      return [];
    }
    const effectiveProjectId = paramProjectId || queryProjectId;
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.ingestionService.findReviewCases(
      { userId, projectId: effectiveProjectId },
      {
        status,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      },
    );
  }

  @Patch('review-cases/:id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async updateReviewCaseStatus(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateReviewCaseStatusDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    if (!this.ingestionService) {
      return null;
    }
    const effectiveProjectId = paramProjectId || queryProjectId || dto?.spaceId;
    return this.ingestionService.updateReviewCaseStatus(
      { userId, projectId: effectiveProjectId },
      id,
      dto.status,
    );
  }
}
