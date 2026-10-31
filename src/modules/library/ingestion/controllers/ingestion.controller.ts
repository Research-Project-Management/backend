import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { IngestionSubmissionDto } from '@/modules/library/ingestion/dto/submission.dto';
import { UnifiedIngestionDto } from '@/modules/library/ingestion/dto/ingestion.dto';
import {
  CaptureUrlDto,
  ConfirmCapturedUrlDto,
} from '@/modules/library/ingestion/dto/capture-url.dto';
import { isUUID } from 'class-validator';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { IngestionService } from '@/modules/library/ingestion/services/ingestion.service';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/ingestion.types';
import { IngestionCommand } from '@/modules/library/ingestion/types/ingestion.types';
import { SubmissionEnvelopeFactory } from '@/modules/library/ingestion/domain/submission-envelope.factory';

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

    const envelope = this.buildEnvelope(
      dto,
      userId,
      effectiveProjectId,
      effectiveIdempotencyKey,
    );

    return this.ingestionService.submit(envelope);
  }

  private buildEnvelope(
    dto: IngestionSubmissionDto,
    userId: string,
    projectId?: string,
    idempotencyKey?: string,
  ): IngestionSubmissionEnvelope {
    return SubmissionEnvelopeFactory.fromSubmissionDto({
      dto,
      userId,
      projectId,
      idempotencyKey,
    });
  }

  @Get(['status/:runId', 'runs/:runId'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get ingestion run status' })
  async getStatus(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.ingestionService.getRunStatus(
      userId,
      runId,
      this.validateProjectId(projectId),
    );
  }

  @Get(['status/:runId/progress', 'runs/:runId/progress'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get ingestion run real-time progress' })
  async getProgress(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.ingestionService.getRunProgress(
      userId,
      runId,
      this.validateProjectId(projectId),
    );
  }

  @Post(['retry/:runId', 'runs/:runId/retry'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Retry failed ingestion run' })
  async retry(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.ingestionService.retryRun(
      userId,
      runId,
      this.validateProjectId(projectId),
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

    const command = this.mapUnifiedDtoToCommand(
      dto,
      userId,
      effectiveProjectId,
      effectiveIdempotencyKey,
    );

    return this.ingestionService.ingest(command);
  }

  private mapUnifiedDtoToCommand(
    dto: UnifiedIngestionDto,
    userId: string,
    projectId?: string,
    idempotencyKey?: string,
  ): IngestionCommand {
    return SubmissionEnvelopeFactory.mapUnifiedDtoToCommand({
      dto,
      userId,
      projectId,
      idempotencyKey,
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
    @Param('projectId') projectId?: string,
  ) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.ingestionService.getRunStatus(
      userId,
      runId,
      this.validateProjectId(projectId),
    );
  }

  @Post('fetch-feed')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Fetch and parse an external RSS/Atom journal or arXiv feed with DB caching & ETag support',
  })
  async fetchFeed(
    @Body() body: { url: string; forceRefresh?: boolean },
    @CurrentUser() user?: { id?: string; userId?: string },
  ) {
    const userId = user?.id || user?.userId;
    return this.urlCaptureService.fetchAcademicFeed(
      body?.url,
      body?.forceRefresh,
      userId,
    );
  }
}
