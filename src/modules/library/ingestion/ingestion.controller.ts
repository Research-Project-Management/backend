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
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { IngestionSubmissionDto } from './dto/submission.dto';
import { UnifiedIngestionDto } from './dto/ingestion.dto';
import { CaptureUrlDto, ConfirmCapturedUrlDto } from './dto/capture-url.dto';

import { isUUID } from 'class-validator';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

// CQRS Use Cases
import { SubmitIngestionUseCase } from './core/use-cases/submit-ingestion.use-case';
import { GetIngestionStatusUseCase } from './core/use-cases/get-ingestion-status.use-case';
import { GetIngestionProgressUseCase } from './core/use-cases/get-ingestion-progress.use-case';
import { RetryIngestionRunUseCase } from './core/use-cases/retry-ingestion-run.use-case';
import { CaptureUrlUseCase } from './core/use-cases/capture-url.use-case';
import { ConfirmCapturedUrlUseCase } from './core/use-cases/confirm-captured-url.use-case';
import { UnifiedIngestUseCase } from './core/use-cases/unified-ingest.use-case';

/**
 * Shared Base Adapter for Library Ingestion Operations.
 */
export abstract class BaseIngestionController {
  constructor(
    protected readonly submitIngestionUseCase: SubmitIngestionUseCase,
    protected readonly getIngestionStatusUseCase: GetIngestionStatusUseCase,
    protected readonly getIngestionProgressUseCase: GetIngestionProgressUseCase,
    protected readonly retryIngestionRunUseCase: RetryIngestionRunUseCase,
    protected readonly captureUrlUseCase: CaptureUrlUseCase,
    protected readonly confirmCapturedUrlUseCase: ConfirmCapturedUrlUseCase,
    protected readonly unifiedIngestUseCase: UnifiedIngestUseCase,
  ) {}

  protected async executeSubmit(
    userId: string,
    idempotencyKeyHeader: string | undefined,
    dto: IngestionSubmissionDto,
    projectId?: string,
  ) {
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;
    const effectiveProjectId = projectId || dto.projectId;

    let payload: any;
    switch (dto.kind) {
      case 'IDENTIFIER':
        payload = {
          kind: 'IDENTIFIER',
          identifierType: (dto.identifierType || 'DOI').toUpperCase(),
          value: (dto.value || dto.identifierValue || '').trim(),
        };
        break;
      case 'RECORD':
        payload = {
          kind: 'RECORD',
          format: (
            (dto.format || dto.recordFormat || 'BIBTEX') as string
          ).toUpperCase(),
          content: dto.content || dto.rawRecord || '',
        };
        break;
      case 'URL':
        payload = {
          kind: 'URL',
          url: dto.url || '',
          previewToken: dto.previewToken,
          filename: dto.filename,
        };
        break;
      case 'FILE':
        payload = {
          kind: 'FILE',
          fileId: dto.fileId || '',
          filename: dto.filename,
        };
        break;
      case 'CONNECTOR':
        payload = {
          kind: 'CONNECTOR',
          connectionId: dto.connectionId || '',
          externalObjectId: dto.externalObjectId || '',
          externalVersion: dto.externalVersion || '',
        };
        break;
      default:
        throw new BadRequestException(
          'Unknown ingestion kind: ' + String((dto as any).kind),
        );
    }

    return this.submitIngestionUseCase.execute({
      projectId: effectiveProjectId,
      userId,
      idempotencyKey: effectiveIdempotencyKey,
      payload,
      collectionIds: dto.collectionIds,
      tagIds: dto.tagIds,
      overrides: dto.overrides,
      contractVersion: dto.contractVersion,
    });
  }

  protected async executeGetStatus(userId: string, runId: string) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.getIngestionStatusUseCase.execute({ userId, runId });
  }

  protected async executeGetProgress(userId: string, runId: string) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.getIngestionProgressUseCase.execute({ userId, runId });
  }

  protected async executeRetry(userId: string, runId: string) {
    return this.retryIngestionRunUseCase.execute({ userId, runId });
  }

  protected async executeIngestUnified(
    userId: string,
    idempotencyKeyHeader: string | undefined,
    dto: UnifiedIngestionDto,
    projectId?: string,
  ) {
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;
    const effectiveProjectId = projectId || (dto as any).projectId;
    let command: any;

    switch (dto.source) {
      case 'doi':
        command = {
          source: 'doi',
          projectId: effectiveProjectId,
          userId,
          doi: dto.doi || '',
          collectionId: dto.collectionId,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'url':
        command = {
          source: 'url',
          projectId: effectiveProjectId,
          userId,
          url: dto.url || '',
          previewToken: dto.previewToken,
          overrides: dto.overrides,
          collectionId: dto.collectionId,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'bibtex':
        command = {
          source: 'bibtex',
          projectId: effectiveProjectId,
          userId,
          content: dto.content || dto.bibtex || '',
          collectionId: dto.collectionId,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'pdf':
        command = {
          source: 'pdf',
          projectId: effectiveProjectId,
          userId,
          fileId: dto.fileId,
          filename: dto.filename,
          collectionId: dto.collectionId,
          overrides: dto.overrides,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      default:
        command = {
          source: dto.source,
          projectId: effectiveProjectId,
          userId,
          idempotencyKey: effectiveIdempotencyKey,
        };
    }

    return this.unifiedIngestUseCase.execute(command);
  }

  protected async executeCaptureUrl(
    userId: string,
    dto: CaptureUrlDto,
    projectId?: string,
  ) {
    return this.captureUrlUseCase.execute({
      url: dto.url,
      scope: {
        projectId,
        userId,
      },
    });
  }

  protected async executeConfirmUrl(
    userId: string,
    dto: ConfirmCapturedUrlDto,
    projectId?: string,
  ) {
    const effectiveScopeId = projectId || dto.projectId || userId;
    return this.confirmCapturedUrlUseCase.execute({
      scopeId: effectiveScopeId,
      userId,
      dto,
    });
  }
}

/**
 * Personal Library Ingestion Controller (/api/v1/library/ingestion).
 * Guarded purely by JwtAuthGuard — scoped to authenticated user.
 */
@ApiTags('Library Ingestion - Personal Pipeline')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library/ingestion')
@UseGuards(JwtAuthGuard)
export class IngestionController extends BaseIngestionController {
  constructor(
    submitIngestionUseCase: SubmitIngestionUseCase,
    getIngestionStatusUseCase: GetIngestionStatusUseCase,
    getIngestionProgressUseCase: GetIngestionProgressUseCase,
    retryIngestionRunUseCase: RetryIngestionRunUseCase,
    captureUrlUseCase: CaptureUrlUseCase,
    confirmCapturedUrlUseCase: ConfirmCapturedUrlUseCase,
    unifiedIngestUseCase: UnifiedIngestUseCase,
  ) {
    super(
      submitIngestionUseCase,
      getIngestionStatusUseCase,
      getIngestionProgressUseCase,
      retryIngestionRunUseCase,
      captureUrlUseCase,
      confirmCapturedUrlUseCase,
      unifiedIngestUseCase,
    );
  }

  @Post('submit')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Submit item ingestion into personal library' })
  async submit(
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestionSubmissionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const resolvedProjectId = paramProjectId || queryProjectId || dto.projectId;
    return this.executeSubmit(
      userId,
      idempotencyKeyHeader,
      dto,
      resolvedProjectId,
    );
  }

  @Get('status/:runId')
  @ApiOperation({ summary: 'Get ingestion run status' })
  async getStatus(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
  ) {
    return this.executeGetStatus(userId, runId);
  }

  @Get('status/:runId/progress')
  @ApiOperation({ summary: 'Get ingestion run real-time progress' })
  async getProgress(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
  ) {
    return this.executeGetProgress(userId, runId);
  }

  @Post('retry/:runId')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Retry failed ingestion run' })
  async retry(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
  ) {
    return this.executeRetry(userId, runId);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Unified multi-source ingest into personal library',
  })
  async ingestUnified(
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: UnifiedIngestionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const resolvedProjectId =
      paramProjectId || queryProjectId || (dto as any).projectId;
    return this.executeIngestUnified(
      userId,
      idempotencyKeyHeader,
      dto,
      resolvedProjectId,
    );
  }

  @Post('capture-url')
  @ApiOperation({
    summary: 'Capture and extract metadata from URL for personal library',
  })
  async captureUrl(
    @CurrentUser('id') userId: string,
    @Body() dto: CaptureUrlDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.executeCaptureUrl(
      userId,
      dto,
      paramProjectId || queryProjectId,
    );
  }

  @Post('confirm-url')
  @ApiOperation({ summary: 'Confirm captured URL into personal library' })
  async confirmUrl(
    @CurrentUser('id') userId: string,
    @Body() dto: ConfirmCapturedUrlDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.executeConfirmUrl(
      userId,
      dto,
      paramProjectId || queryProjectId,
    );
  }
}

/**
 * Project Library Ingestion Controller (/api/v1/projects/:projectId/library/ingestion).
 * Strictly validates :projectId with ParseUUIDPipe and enforces project roles.
 */
@ApiTags('Library Ingestion - Project Pipeline')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/projects/:projectId/library/ingestion')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ProjectIngestionController extends BaseIngestionController {
  constructor(
    submitIngestionUseCase: SubmitIngestionUseCase,
    getIngestionStatusUseCase: GetIngestionStatusUseCase,
    getIngestionProgressUseCase: GetIngestionProgressUseCase,
    retryIngestionRunUseCase: RetryIngestionRunUseCase,
    captureUrlUseCase: CaptureUrlUseCase,
    confirmCapturedUrlUseCase: ConfirmCapturedUrlUseCase,
    unifiedIngestUseCase: UnifiedIngestUseCase,
  ) {
    super(
      submitIngestionUseCase,
      getIngestionStatusUseCase,
      getIngestionProgressUseCase,
      retryIngestionRunUseCase,
      captureUrlUseCase,
      confirmCapturedUrlUseCase,
      unifiedIngestUseCase,
    );
  }

  @Post('submit')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Submit item ingestion into project library' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async submit(
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestionSubmissionDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeSubmit(userId, idempotencyKeyHeader, dto, projectId);
  }

  @Get('status/:runId')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get project ingestion run status' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getStatus(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
  ) {
    return this.executeGetStatus(userId, runId);
  }

  @Get('status/:runId/progress')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get project ingestion run real-time progress' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getProgress(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
  ) {
    return this.executeGetProgress(userId, runId);
  }

  @Post('retry/:runId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Retry failed project ingestion run' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async retry(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
  ) {
    return this.executeRetry(userId, runId);
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Unified multi-source ingest into project library' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async ingestUnified(
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: UnifiedIngestionDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeIngestUnified(
      userId,
      idempotencyKeyHeader,
      dto,
      projectId,
    );
  }

  @Post('capture-url')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Capture and extract metadata from URL for project library',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async captureUrl(
    @CurrentUser('id') userId: string,
    @Body() dto: CaptureUrlDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeCaptureUrl(userId, dto, projectId);
  }

  @Post('confirm-url')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Confirm captured URL into project library' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async confirmUrl(
    @CurrentUser('id') userId: string,
    @Body() dto: ConfirmCapturedUrlDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeConfirmUrl(userId, dto, projectId);
  }
}
