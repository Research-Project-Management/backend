import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  Inject,
  Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { IngestionPort, INGESTION_PORT } from './types/ingestion.types';
import { IngestionService } from './ingestion.service';
import { IngestionSubmissionDto } from './dto/ingestion-submission.dto';
import {
  StartIngestionDto,
  IngestDoiDto,
  IngestBibtexDto,
  IngestPdfDto,
  UnifiedIngestionDto,
} from './dto/ingestion.dto';
import { CaptureUrlDto, ConfirmCapturedUrlDto } from './dto/capture-url.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/ingestion',
  'api/v1/workspace/:workspaceId/library/ingestion',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class IngestionController {
  constructor(
    @Inject(INGESTION_PORT)
    private readonly unifiedService: IngestionPort,
    private readonly ingestionService: IngestionService,
  ) {}

  /**
   * Primary Fast-Path Submission Endpoint (202 Accepted)
   */
  @Post('submit')
  @HttpCode(HttpStatus.ACCEPTED)
  @WorkspaceRoles('owner', 'admin', 'member')
  async submit(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestionSubmissionDto,
  ) {
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;

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
        payload = {
          kind: 'IDENTIFIER',
          identifierType: 'DOI',
          value: '',
        };
    }

    return this.ingestionService.submit({
      workspaceId,
      userId,
      idempotencyKey: effectiveIdempotencyKey,
      payload,
      collectionIds: dto.collectionIds,
      tagIds: dto.tagIds,
      overrides: dto.overrides,
      contractVersion: dto.contractVersion,
    });
  }

  /**
   * Ingestion Run Status Endpoint
   */
  @Get('status/:runId')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getStatus(
    @Param('workspaceId') workspaceId: string,
    @Param('runId') runId: string,
  ) {
    return this.ingestionService.getRunStatus(workspaceId, runId);
  }

  /**
   * Ingestion Run Real-time Progress Endpoint (Zotero-style progress modal)
   */
  @Get('status/:runId/progress')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getProgress(
    @Param('workspaceId') workspaceId: string,
    @Param('runId') runId: string,
  ) {
    return this.ingestionService.getRunProgress(workspaceId, runId);
  }

  /**
   * Ingestion Run Retry Endpoint
   */
  @Post('retry/:runId')
  @HttpCode(HttpStatus.ACCEPTED)
  @WorkspaceRoles('owner', 'admin', 'member')
  async retry(
    @Param('workspaceId') workspaceId: string,
    @Param('runId') runId: string,
  ) {
    return this.ingestionService.retryRun(workspaceId, runId);
  }

  // ──────────────── Backward Compatibility Endpoints ──────────────────────────

  // ─── Legacy Backward-Compatibility Endpoint ─────────────────────────────────
  // POST /api/v1/workspaces/:workspaceId/library/ingestion
  // Kept for frontend consumers that have not yet migrated to /submit.
  @Post()
  @HttpCode(HttpStatus.OK)
  @WorkspaceRoles('owner', 'admin', 'member')
  async ingestUnified(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: UnifiedIngestionDto,
  ) {
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;
    let command: any;

    switch (dto.source) {
      case 'doi':
        command = {
          source: 'doi',
          workspaceId,
          userId,
          doi: dto.doi || '',
          collectionId: dto.collectionId,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'url':
        command = {
          source: 'url',
          workspaceId,
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
          workspaceId,
          userId,
          content: dto.content || dto.bibtex || '',
          collectionId: dto.collectionId,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'pdf':
        command = {
          source: 'pdf',
          workspaceId,
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
          workspaceId,
          userId,
          idempotencyKey: effectiveIdempotencyKey,
        };
    }

    return this.unifiedService.ingest(command);
  }

  @Post('capture-url')
  @WorkspaceRoles('owner', 'admin', 'member')
  async captureUrl(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CaptureUrlDto,
  ) {
    return this.ingestionService.captureUrl(dto.url, { workspaceId, userId });
  }

  @Post('confirm-url')
  @WorkspaceRoles('owner', 'admin', 'member')
  async confirmUrl(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ConfirmCapturedUrlDto,
  ) {
    return this.ingestionService.confirmCapturedUrl(
      workspaceId,
      userId || 'system',
      dto,
    );
  }

  @Post('start')
  @WorkspaceRoles('owner', 'admin', 'member')
  async startRun(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: StartIngestionDto,
  ) {
    return this.ingestionService.startRun(workspaceId, userId || 'system', {
      ...dto,
      idempotencyKey: idempotencyKeyHeader || dto.idempotencyKey,
    });
  }

  @Post('doi')
  @WorkspaceRoles('owner', 'admin', 'member')
  async ingestDoi(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestDoiDto,
  ) {
    return this.ingestionService.ingestDoi(workspaceId, userId || 'system', {
      ...dto,
      idempotencyKey: idempotencyKeyHeader || dto.idempotencyKey,
    });
  }

  @Post('bibtex')
  @WorkspaceRoles('owner', 'admin', 'member')
  async ingestBibtex(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestBibtexDto,
  ) {
    return this.ingestionService.ingestBibtex(workspaceId, userId || 'system', {
      ...dto,
      idempotencyKey: idempotencyKeyHeader || dto.idempotencyKey,
    });
  }

  @Post('pdf')
  @WorkspaceRoles('owner', 'admin', 'member')
  async ingestPdf(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestPdfDto,
  ) {
    return this.unifiedService.ingest({
      source: 'pdf',
      workspaceId,
      userId,
      fileId: dto.fileId,
      filename: dto.filename,
      collectionId: dto.collectionId,
      overrides: dto.overrides,
      idempotencyKey: idempotencyKeyHeader || dto.idempotencyKey,
    });
  }
}
