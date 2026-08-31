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
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { CurrentWorkspace } from '../../../modules/iam/authz/decorators/current-workspace.decorator';
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
  'api/library/papers/:workspaceId/ingest',
  'api/library/ingest',
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
  async submit(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestionSubmissionDto,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;

    let payload: any;
    switch (dto.kind) {
      case 'IDENTIFIER':
        payload = {
          kind: 'IDENTIFIER',
          identifierType: dto.identifierType || 'DOI',
          value: dto.value || '',
        };
        break;
      case 'RECORD':
        payload = {
          kind: 'RECORD',
          format: dto.format || 'BIBTEX',
          content: dto.content || '',
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
      workspaceId: targetWsId,
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
  async getStatus(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('runId') runId: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.ingestionService.getRunStatus(targetWsId, runId);
  }

  /**
   * Ingestion Run Retry Endpoint
   */
  @Post('retry/:runId')
  @HttpCode(HttpStatus.ACCEPTED)
  async retry(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('runId') runId: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.ingestionService.retryRun(targetWsId, runId);
  }

  // ── Backward Compatibility Endpoints ─────────────────────────────────────

  @Post(['', 'unified'])
  @HttpCode(HttpStatus.OK)
  async ingestUnified(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: UnifiedIngestionDto,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;
    let command: any;

    switch (dto.source) {
      case 'doi':
        command = {
          source: 'doi',
          workspaceId: targetWsId,
          userId,
          doi: dto.doi || '',
          collectionId: dto.collectionId,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'url':
        command = {
          source: 'url',
          workspaceId: targetWsId,
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
          workspaceId: targetWsId,
          userId,
          content: dto.content || dto.bibtex || '',
          collectionId: dto.collectionId,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'pdf':
        command = {
          source: 'pdf',
          workspaceId: targetWsId,
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
          workspaceId: targetWsId,
          userId,
          idempotencyKey: effectiveIdempotencyKey,
        };
    }

    return this.unifiedService.ingest(command);
  }

  @Post('capture-url')
  async captureUrl(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CaptureUrlDto,
  ) {
    return this.ingestionService.captureUrl(
      dto.url,
      workspaceId,
    );
  }

  @Post('confirm-url')
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
  async startRun(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: StartIngestionDto,
  ) {
    return this.ingestionService.startRun(
      workspaceId,
      userId || 'system',
      {
        ...dto,
        idempotencyKey: idempotencyKeyHeader || dto.idempotencyKey,
      },
    );
  }

  @Post('doi')
  async ingestDoi(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestDoiDto,
  ) {
    return this.ingestionService.ingestDoi(
      workspaceId,
      userId || 'system',
      {
        ...dto,
        idempotencyKey: idempotencyKeyHeader || dto.idempotencyKey,
      },
    );
  }

  @Post('bibtex')
  async ingestBibtex(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestBibtexDto,
  ) {
    return this.ingestionService.ingestBibtex(
      workspaceId,
      userId || 'system',
      {
        ...dto,
        idempotencyKey: idempotencyKeyHeader || dto.idempotencyKey,
      },
    );
  }

  @Post('pdf')
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
