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
import {
  SubmissionPayload,
  IdentifierType,
  RecordFormat,
} from '@/modules/library/ingestion/types/submission.types';
import { IngestionCommand } from '@/modules/library/ingestion/types/ingestion.types';

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
  @ApiParam({ name: 'projectId', required: false, type: 'string', format: 'uuid' })
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
    let command: IngestionCommand;

    const overrideObj =
      dto.overrides && typeof dto.overrides === 'object' ? dto.overrides : {};
    const effectiveCollectionId =
      dto.collectionId ||
      (typeof overrideObj.collectionId === 'string'
        ? overrideObj.collectionId
        : undefined);

    switch (dto.source) {
      case 'doi':
        command = {
          source: 'doi',
          projectId: effectiveProjectId,
          userId,
          doi: dto.doi || '',
          collectionId: effectiveCollectionId,
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
          collectionId: effectiveCollectionId,
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
          collectionId: effectiveCollectionId,
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
          collectionId: effectiveCollectionId,
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
          collectionId: effectiveCollectionId,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'bibtex':
        command = {
          source: 'bibtex',
          projectId: effectiveProjectId,
          userId,
          content: dto.content || dto.bibtex || '',
          collectionId: effectiveCollectionId,
          overrides: dto.overrides,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'ris':
        command = {
          source: 'ris',
          projectId: effectiveProjectId,
          userId,
          content: dto.content || dto.ris || '',
          collectionId: effectiveCollectionId,
          overrides: dto.overrides,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'csl_json':
      case 'endnote_xml':
      case 'mods':
      case 'zotero_rdf':
      case 'medline':
      case 'csv':
        command = {
          source: dto.source,
          projectId: effectiveProjectId,
          userId,
          content: dto.content || '',
          collectionId: effectiveCollectionId,
          overrides: dto.overrides,
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
          collectionId: effectiveCollectionId,
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
          collectionId: effectiveCollectionId,
          overrides: dto.overrides,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      default:
        command = {
          source: dto.source,
          projectId: effectiveProjectId,
          userId,
          collectionId: effectiveCollectionId,
          overrides: dto.overrides,
          idempotencyKey: effectiveIdempotencyKey,
        };
    }

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
    summary: 'Fetch and parse an external RSS/Atom journal or arXiv feed with DB caching & ETag support',
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
