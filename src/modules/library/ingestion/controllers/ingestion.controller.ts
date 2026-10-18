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
import { IngestionSubmissionDto } from '@/modules/library/ingestion/dto/submission.dto';
import { UnifiedIngestionDto } from '@/modules/library/ingestion/dto/ingestion.dto';
import {
  CaptureUrlDto,
  ConfirmCapturedUrlDto,
} from '@/modules/library/ingestion/dto/capture-url.dto';
import { ReResolveMetadataDto } from '@/modules/library/ingestion/dto/curation.dto';
import { isUUID } from 'class-validator';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { IngestionService } from '@/modules/library/ingestion/services/ingestion.service';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';
import {
  SubmissionPayload,
  IdentifierType,
  RecordFormat,
} from '@/modules/library/ingestion/types/submission.types';
import { IngestionCommand } from '@/modules/library/ingestion/types/ingestion.types';

/**
 * Shared Base Adapter for Library Ingestion Operations.
 */
export abstract class BaseIngestionController {
  constructor(
    protected readonly ingestionService: IngestionService,
    protected readonly urlCaptureService: UrlCaptureService,
  ) {}

  protected async executeSubmit(
    userId: string,
    idempotencyKeyHeader: string | undefined,
    dto: IngestionSubmissionDto,
    projectId?: string,
  ) {
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;
    const effectiveProjectId = projectId || dto.projectId;

    let payload: SubmissionPayload;
    switch (dto.kind) {
      case 'IDENTIFIER':
        payload = {
          kind: 'IDENTIFIER',
          identifierType: (
            dto.identifierType || 'DOI'
          ).toUpperCase() as IdentifierType,
          value: (dto.value || dto.identifierValue || '').trim(),
        };
        break;
      case 'RECORD':
        payload = {
          kind: 'RECORD',
          format: (
            dto.format ||
            dto.recordFormat ||
            'BIBTEX'
          ).toUpperCase() as RecordFormat,
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
          'Unknown ingestion kind: ' + String((dto as { kind?: unknown }).kind),
        );
    }

    const effectiveCollectionIds =
      dto.collectionIds ?? (dto.collectionId ? [dto.collectionId] : undefined);

    return this.ingestionService.submit({
      projectId: effectiveProjectId,
      userId,
      idempotencyKey: effectiveIdempotencyKey,
      payload,
      collectionIds: effectiveCollectionIds,
      tagIds: dto.tagIds,
      overrides: dto.overrides,
      contractVersion: dto.contractVersion,
    });
  }

  protected async executeGetStatus(userId: string, runId: string) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.ingestionService.getRunStatus(userId, runId);
  }

  protected async executeGetProgress(userId: string, runId: string) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.ingestionService.getRunProgress(userId, runId);
  }

  protected async executeRetry(userId: string, runId: string) {
    return this.ingestionService.retryRun(userId, runId);
  }

  protected async executeIngestUnified(
    userId: string,
    idempotencyKeyHeader: string | undefined,
    dto: UnifiedIngestionDto,
    projectId?: string,
  ) {
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;
    const effectiveProjectId = projectId || dto.projectId;
    let command: IngestionCommand;

    switch (dto.source) {
      case 'doi':
        command = {
          source: 'doi',
          projectId: effectiveProjectId,
          userId,
          doi: dto.doi || '',
          collectionId: dto.collectionId,
          overrides: dto.overrides,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'arxiv':
        command = {
          source: 'arxiv',
          projectId: effectiveProjectId,
          userId,
          arxivId: dto.arxivId || '',
          collectionId: dto.collectionId,
          overrides: dto.overrides,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'pmid':
        command = {
          source: 'pmid',
          projectId: effectiveProjectId,
          userId,
          pmid: dto.pmid || '',
          collectionId: dto.collectionId,
          overrides: dto.overrides,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'isbn':
        command = {
          source: 'isbn',
          projectId: effectiveProjectId,
          userId,
          isbn: dto.isbn || '',
          collectionId: dto.collectionId,
          overrides: dto.overrides,
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

      case 'ris':
        command = {
          source: 'ris',
          projectId: effectiveProjectId,
          userId,
          content: dto.content || dto.ris || '',
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

      case 'zotero':
        command = {
          source: 'zotero',
          projectId: effectiveProjectId,
          userId,
          connectionId: dto.connectionId,
          externalItemKey: dto.externalItemKey,
          collectionId: dto.collectionId,
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

    return this.ingestionService.ingest(command);
  }

  protected async executeCaptureUrl(
    userId: string,
    dto: CaptureUrlDto,
    projectId?: string,
  ) {
    return this.urlCaptureService.captureUrl(dto.url, {
      projectId,
      userId,
    });
  }

  protected async executeConfirmUrl(
    userId: string,
    dto: ConfirmCapturedUrlDto,
    projectId?: string,
  ) {
    const effectiveScopeId = projectId || dto.projectId || userId;

    return this.urlCaptureService.confirmCapturedUrl(
      effectiveScopeId,
      userId,
      dto,
    );
  }

  protected async executeReResolveMetadata(
    userId: string,
    itemId: string,
    dto: ReResolveMetadataDto,
    projectId?: string,
  ) {
    return this.ingestionService.reResolveMetadata(
      userId,
      itemId,
      dto,
      projectId,
    );
  }
}

/**
 * User Library Ingestion Controller (/api/v1/library/ingestion).
 * Guarded purely by JwtAuthGuard — scoped to authenticated user.
 */
@ApiTags('Library Ingestion - User Pipeline')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library/ingestion')
@UseGuards(JwtAuthGuard)
export class IngestionController extends BaseIngestionController {
  constructor(
    ingestionService: IngestionService,
    urlCaptureService: UrlCaptureService,
  ) {
    super(ingestionService, urlCaptureService);
  }

  @Post(['items/:id/re-resolve', ':id/re-resolve'])
  @ApiOperation({
    summary: 'Re-resolve bibliographic metadata on demand from open mirrors',
  })
  async reResolveMetadata(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ReResolveMetadataDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId =
      paramProjectId || queryProjectId || dto?.projectId;
    return this.executeReResolveMetadata(userId, id, dto, effectiveProjectId);
  }

  @Post('submit')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Submit item ingestion into user library' })
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
    summary: 'Unified multi-source ingest into user library',
  })
  async ingestUnified(
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: UnifiedIngestionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const resolvedProjectId = paramProjectId || queryProjectId || dto.projectId;
    return this.executeIngestUnified(
      userId,
      idempotencyKeyHeader,
      dto,
      resolvedProjectId,
    );
  }

  @Post('capture-url')
  @ApiOperation({
    summary: 'Capture and extract metadata from URL for user library',
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
  @ApiOperation({ summary: 'Confirm captured URL into user library' })
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
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class ProjectIngestionController extends BaseIngestionController {
  constructor(
    ingestionService: IngestionService,
    urlCaptureService: UrlCaptureService,
  ) {
    super(ingestionService, urlCaptureService);
  }

  @Post(['items/:id/re-resolve', ':id/re-resolve'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary:
      'Re-resolve bibliographic metadata on demand from open mirrors for project item',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async reResolveMetadata(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() dto: ReResolveMetadataDto,
  ) {
    return this.executeReResolveMetadata(userId, id, dto, projectId);
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
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('runId') runId: string,
  ) {
    return this.executeGetStatus(projectId, runId);
  }

  @Get('status/:runId/progress')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get project ingestion run real-time progress' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getProgress(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('runId') runId: string,
  ) {
    return this.executeGetProgress(projectId, runId);
  }

  @Post('retry/:runId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Retry failed project ingestion run' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async retry(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('runId') runId: string,
  ) {
    return this.executeRetry(projectId, runId);
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
