import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  ProjectRoles,
  RequireOperator,
} from '@/modules/project/access';
import {
  IngestionSubmissionDto,
  UnifiedIngestionDto,
  CaptureUrlDto,
  ConfirmCapturedUrlDto,
} from '@/modules/library/ingestion/dto/ingestion.dto';
import { FetchAcademicFeedDto } from '@/modules/library/ingestion/dto/feeds.dto';
import { IngestionService } from '@/modules/library/ingestion/services/ingestion.service';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';
import { FeedRetrievalService } from '@/modules/library/ingestion/services/feed-retrieval.service';
import { DuplicateDetectorService } from '@/modules/library/ingestion/services/duplicate-detector.service';
import { DuplicateMergerService } from '@/modules/library/ingestion/services/duplicate-merger.service';
import { QualityService } from '@/modules/library/ingestion/services/ingestion-verifier.service';
import {
  IngestionFacade,
  INGESTION_FACADE,
  type IIngestionFacade,
} from '@/modules/library/ingestion/services/ingestion.facade';
import { RetractionService } from '@/modules/library/ingestion/services/retraction.service';
import { FeedsService } from '@/modules/library/ingestion/services/feeds.service';

/**
 * Unified Library Ingestion Controller.
 * Serves both User Library (/api/v1/library/ingestion) and Project Library (/api/v1/projects/:projectId/library/ingestion).
 */
@ApiTags('Library Ingestion')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/ingestion',
  'api/v1/spaces/:spaceId/library/ingestion',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class IngestionController {
  constructor(
    protected readonly ingestionService: IngestionService,
    protected readonly urlCaptureService: UrlCaptureService,
    @Optional() protected readonly feedRetrievalService?: FeedRetrievalService,
  ) {}

  private validateProjectId(projectId?: string): string | undefined {
    if (!projectId) return undefined;
    if (!isUUID(projectId)) {
      throw new BadRequestException('Invalid projectId UUID');
    }
    return projectId;
  }

  @Post('submit')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Submit item ingestion into library' })
  @ApiParam({
    name: 'spaceId',
    required: false,
    type: 'string',
    format: 'uuid',
  })
  async submit(
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestionSubmissionDto,
    @Param('spaceId') paramProjectId?: string,
    @Query('spaceId') queryProjectId?: string,
  ) {
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;
    const effectiveProjectId =
      this.validateProjectId(paramProjectId) ||
      this.validateProjectId(queryProjectId) ||
      this.validateProjectId(dto.spaceId);

    return this.ingestionService.submitFromDto({
      dto,
      userId,
      projectId: effectiveProjectId,
      idempotencyKey: effectiveIdempotencyKey,
    });
  }

  @Get(['status/:runId', 'runs/:runId'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get ingestion run status' })
  async getStatus(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
    @Param('spaceId') paramProjectId?: string,
    @Query('spaceId') queryProjectId?: string,
  ) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.ingestionService.getRunStatus(
      userId,
      runId,
      this.validateProjectId(paramProjectId || queryProjectId),
    );
  }

  @Get(['status/:runId/progress', 'runs/:runId/progress'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get ingestion run real-time progress' })
  async getProgress(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
    @Param('spaceId') paramProjectId?: string,
    @Query('spaceId') queryProjectId?: string,
  ) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.ingestionService.getRunProgress(
      userId,
      runId,
      this.validateProjectId(paramProjectId || queryProjectId),
    );
  }

  @Post(['retry/:runId', 'runs/:runId/retry'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Retry failed ingestion run' })
  async retry(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
    @Param('spaceId') paramProjectId?: string,
    @Query('spaceId') queryProjectId?: string,
  ) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.ingestionService.retryRun(
      userId,
      runId,
      this.validateProjectId(paramProjectId || queryProjectId),
    );
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Unified multi-source ingest into library' })
  async ingestUnified(
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: UnifiedIngestionDto,
    @Param('spaceId') paramProjectId?: string,
    @Query('spaceId') queryProjectId?: string,
  ) {
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;
    const effectiveProjectId =
      this.validateProjectId(paramProjectId) ||
      this.validateProjectId(queryProjectId) ||
      this.validateProjectId(dto.spaceId);

    return this.ingestionService.ingestUnifiedDto({
      dto,
      userId,
      projectId: effectiveProjectId,
      idempotencyKey: effectiveIdempotencyKey,
    });
  }

  @Post('capture-url')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Capture and extract metadata from URL for library',
  })
  async captureUrl(
    @CurrentUser('id') userId: string,
    @Body() dto: CaptureUrlDto,
    @Param('spaceId') paramProjectId?: string,
    @Query('spaceId') queryProjectId?: string,
  ) {
    return this.urlCaptureService.captureUrl(dto.url, {
      projectId:
        this.validateProjectId(paramProjectId) ||
        this.validateProjectId(queryProjectId),
      userId,
    });
  }

  @Post('confirm-url')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Confirm captured URL into library' })
  async confirmUrl(
    @CurrentUser('id') userId: string,
    @Body() dto: ConfirmCapturedUrlDto,
    @Param('spaceId') paramProjectId?: string,
    @Query('spaceId') queryProjectId?: string,
  ) {
    const effectiveSpaceId =
      this.validateProjectId(paramProjectId) ||
      this.validateProjectId(queryProjectId) ||
      this.validateProjectId(dto.spaceId) ||
      undefined;

    return this.urlCaptureService.confirmCapturedUrl(
      effectiveSpaceId,
      userId,
      dto,
    );
  }

  @Get(['runs/:id/explain', 'runs/:id/Explain'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get ingestion run explain trace' })
  async getExplain(
    @CurrentUser('id') userId: string,
    @Param('id') runId: string,
    @Param('spaceId') paramProjectId?: string,
    @Query('spaceId') queryProjectId?: string,
  ) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.ingestionService.getRunStatus(
      userId,
      runId,
      this.validateProjectId(paramProjectId || queryProjectId),
    );
  }

  @Post('fetch-feed')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary:
      'Fetch and parse an external RSS/Atom journal or arXiv feed with DB caching & ETag support',
  })
  async fetchFeed(
    @Body() dto: FetchAcademicFeedDto,
    @CurrentUser() user?: { id?: string; userId?: string },
  ) {
    const userId = user?.id || user?.userId;
    if (this.feedRetrievalService) {
      return this.feedRetrievalService.fetchAcademicFeed(
        dto.url,
        dto.forceRefresh,
        userId,
      );
    }
    return this.urlCaptureService.fetchAcademicFeed(
      dto.url,
      dto.forceRefresh,
      userId,
    );
  }
}
