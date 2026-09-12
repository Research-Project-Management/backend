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
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import { IngestionPort, INGESTION_PORT } from './types/ingestion.types';
import { IngestionService } from './ingestion.service';
import { IngestionSubmissionDto } from './dto/submission.dto';
import { UnifiedIngestionDto } from './dto/ingestion.dto';
import { CaptureUrlDto, ConfirmCapturedUrlDto } from './dto/capture-url.dto';

@Controller('api/v1/library/ingestion')
@UseGuards(JwtAuthGuard)
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
      projectId: userId,
      workspaceId: userId,
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
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
  ) {
    return this.ingestionService.getRunStatus(userId, runId);
  }

  /**
   * Ingestion Run Real-time Progress Endpoint (Zotero-style progress modal)
   */
  @Get('status/:runId/progress')
  async getProgress(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
  ) {
    return this.ingestionService.getRunProgress(userId, runId);
  }

  /**
   * Ingestion Run Retry Endpoint
   */
  @Post('retry/:runId')
  @HttpCode(HttpStatus.ACCEPTED)
  async retry(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
  ) {
    return this.ingestionService.retryRun(userId, runId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async ingestUnified(
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
          workspaceId: userId,
          projectId: userId,
          userId,
          doi: dto.doi || '',
          collectionId: dto.collectionId,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'url':
        command = {
          source: 'url',
          workspaceId: userId,
          projectId: userId,
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
          workspaceId: userId,
          projectId: userId,
          userId,
          content: dto.content || dto.bibtex || '',
          collectionId: dto.collectionId,
          idempotencyKey: effectiveIdempotencyKey,
        };
        break;

      case 'pdf':
        command = {
          source: 'pdf',
          workspaceId: userId,
          projectId: userId,
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
          workspaceId: userId,
          projectId: userId,
          userId,
          idempotencyKey: effectiveIdempotencyKey,
        };
    }

    return this.unifiedService.ingest(command);
  }

  @Post('capture-url')
  async captureUrl(
    @CurrentUser('id') userId: string,
    @Body() dto: CaptureUrlDto,
  ) {
    return this.ingestionService.captureUrl(dto.url, { workspaceId: userId, projectId: userId, userId });
  }

  @Post('confirm-url')
  async confirmUrl(
    @CurrentUser('id') userId: string,
    @Body() dto: ConfirmCapturedUrlDto,
  ) {
    return this.ingestionService.confirmCapturedUrl(
      userId,
      userId,
      dto,
    );
  }
}
