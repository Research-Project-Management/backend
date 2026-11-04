import { Controller, Get, Post, Param, Query, Body, Headers, UseGuards, HttpCode, HttpStatus, BadRequestException, Optional, Injectable } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { IngestionSubmissionDto, UnifiedIngestionDto, CaptureUrlDto, ConfirmCapturedUrlDto, FetchAcademicFeedDto } from '@/modules/library/ingestion/dto/ingestion.dto';
import { isUUID } from 'class-validator';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { IngestionService } from '@/modules/library/ingestion/services/ingestion.service';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';
import { FeedRetrievalService } from '@/modules/library/ingestion/services/feed-retrieval.service';
import { IngestionSubmissionEnvelope, IngestionCommand, IngestionAcceptedResult, DuplicateClusterResult, RetractionCheckResult } from '@/modules/library/ingestion/types/ingestion.types';
import { SubmissionEnvelopeFactory } from '@/modules/library/ingestion/domain/submission-envelope.factory';
import { DuplicateDetectorService } from '@/modules/library/ingestion/services/duplicate-detector.service';
import { QualityService, QualityAuditReport } from '@/modules/library/ingestion/services/ingestion-verifier.service';
import { RetractionService } from '@/modules/library/ingestion/services/retraction.service';
import { IngestionRunSnapshot, INGESTION_FACADE, IIngestionFacade, ReconcileExtractedCandidatePayload } from '@/modules/library/core';

/**
 * Unified Library Ingestion Controller.
 * Serves both User Library (/api/v1/library/ingestion) and Project Library (/api/v1/projects/:projectId/library/ingestion).
 * ProjectAccessGuard allows user-scoped requests when :projectId is absent, and enforces project membership/roles when present.
 */
@ApiTags('Library Ingestion')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/ingestion',
  'api/v1/projects/:projectId/library/ingestion',
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
    name: 'projectId',
    required: false,
    type: 'string',
    format: 'uuid',
  })
  async submit(
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestionSubmissionDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;
    const effectiveProjectId =
      this.validateProjectId(paramProjectId) ||
      this.validateProjectId(queryProjectId) ||
      this.validateProjectId(dto.projectId);

    const envelope = SubmissionEnvelopeFactory.fromSubmissionDto({
      dto,
      userId,
      projectId: effectiveProjectId,
      idempotencyKey: effectiveIdempotencyKey,
    });

    return this.ingestionService.submit(envelope);
  }

  @Get(['status/:runId', 'runs/:runId'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get ingestion run status' })
  async getStatus(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
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
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
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
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
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
  @ApiOperation({
    summary: 'Unified multi-source ingest into library',
  })
  async ingestUnified(
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: UnifiedIngestionDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;
    const effectiveProjectId =
      this.validateProjectId(paramProjectId) ||
      this.validateProjectId(queryProjectId) ||
      this.validateProjectId(dto.projectId);

    const command = SubmissionEnvelopeFactory.mapUnifiedDtoToCommand({
      dto,
      userId,
      projectId: effectiveProjectId,
      idempotencyKey: effectiveIdempotencyKey,
    });

    return this.ingestionService.ingest(command);
  }

  @Post('capture-url')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Capture and extract metadata from URL for library',
  })
  async captureUrl(
    @CurrentUser('id') userId: string,
    @Body() dto: CaptureUrlDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
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
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveScopeId =
      this.validateProjectId(paramProjectId) ||
      this.validateProjectId(queryProjectId) ||
      this.validateProjectId(dto.projectId) ||
      undefined;

    return this.urlCaptureService.confirmCapturedUrl(
      effectiveScopeId,
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
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
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
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
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

export { INGESTION_FACADE };
export type { IIngestionFacade };

/**
 * Public Facade for Ingestion Bounded Context (Supporting Domain).
 * Shields ingestion pipelines, curation/dedup algorithms, and retraction checks.
 */
@Injectable()
export class IngestionFacade implements IIngestionFacade {
  constructor(
    private readonly ingestionService: IngestionService,
    private readonly duplicateDetector: DuplicateDetectorService,
    private readonly qualityService: QualityService,
    private readonly retractionService: RetractionService,
  ) {}

  async submitIngestion(
    envelope: IngestionSubmissionEnvelope,
    options?: { enqueue?: boolean },
  ): Promise<IngestionAcceptedResult> {
    return this.ingestionService.submit(envelope, options);
  }

  async getIngestionStatus(
    userId: string,
    runId: string,
  ): Promise<IngestionRunSnapshot> {
    return this.ingestionService.getRunStatus(userId, runId);
  }

  async findDuplicates(
    userId: string,
    projectId?: string,
  ): Promise<DuplicateClusterResult[]> {
    return this.duplicateDetector.detectDuplicates(userId, projectId);
  }

  async getQualityAudit(
    userId: string,
    projectId?: string,
  ): Promise<QualityAuditReport> {
    return this.qualityService.getQualityAudit(userId, projectId);
  }

  async checkRetraction(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<RetractionCheckResult> {
    return this.retractionService.checkItem(userId, itemId, projectId);
  }

  async reResolveMetadata(
    userId: string,
    itemId: string,
    options?: {
      doi?: string;
      arxivId?: string;
      pmid?: string;
      isbn?: string;
      title?: string;
      forceRefresh?: boolean;
      expectedVersion?: number;
    },
    projectId?: string,
  ): Promise<Awaited<ReturnType<IngestionService['reResolveMetadata']>>> {
    return this.ingestionService.reResolveMetadata(
      userId,
      itemId,
      options,
      projectId,
    );
  }

  async reconcileExtractedCandidate(
    payload: ReconcileExtractedCandidatePayload,
  ): Promise<{
    updated: boolean;
    updatedFields: string[];
    rejectedCitedDoi?: string;
  }> {
    return this.ingestionService.reconcileExtractedCandidate(payload);
  }
}
