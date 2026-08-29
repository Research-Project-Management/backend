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
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { CurrentWorkspace } from '../../../modules/iam/authz/decorators/current-workspace.decorator';
import {
  IUnifiedIngestionService,
  UNIFIED_INGESTION_SERVICE,
} from './types/ingestion.contracts';
import { IngestionService } from './ingestion.service';
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
    @Inject(UNIFIED_INGESTION_SERVICE)
    private readonly unifiedService: IUnifiedIngestionService,
    private readonly ingestionService: IngestionService,
  ) {}

  /**
   * Unified Ingestion Endpoint (Supports DOI, URL, BibTeX, PDF, Zotero)
   */
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

      case 'zotero':
        command = {
          source: 'zotero',
          workspaceId: targetWsId,
          userId,
          connectionId: dto.connectionId || '',
          externalItemKey: dto.externalItemKey || '',
          payload: dto.payload,
          collectionId: dto.collectionId,
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

    const result = await this.unifiedService.ingest(command);
    return {
      success: true,
      data: result,
    };
  }

  @Post('capture-url')
  async captureUrl(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CaptureUrlDto,
  ) {
    const metadata = await this.ingestionService.captureUrl(
      dto.url,
      workspaceId,
    );
    return {
      success: true,
      data: metadata,
    };
  }

  @Post('confirm-url')
  async confirmUrl(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ConfirmCapturedUrlDto,
  ) {
    const item = await this.ingestionService.confirmCapturedUrl(
      workspaceId,
      userId || 'system',
      dto,
    );
    return {
      success: true,
      data: item,
    };
  }

  @Post('start')
  async startRun(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: StartIngestionDto,
  ) {
    const run = await this.ingestionService.startRun(
      workspaceId,
      userId || 'system',
      {
        ...dto,
        idempotencyKey: idempotencyKeyHeader || dto.idempotencyKey,
      },
    );
    return {
      success: true,
      data: run,
    };
  }

  @Get('status/:runId')
  async getStatus(
    @Param('workspaceId') workspaceId: string,
    @Param('runId') runId: string,
  ) {
    const status = await this.unifiedService.getRunStatus(workspaceId, runId);
    return {
      success: true,
      data: status,
    };
  }

  @Post('doi')
  async ingestDoi(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestDoiDto,
  ) {
    const item = await this.ingestionService.ingestDoi(
      workspaceId,
      userId || 'system',
      {
        ...dto,
        idempotencyKey: idempotencyKeyHeader || dto.idempotencyKey,
      },
    );
    return {
      success: true,
      data: item,
    };
  }

  @Post('bibtex')
  async ingestBibtex(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestBibtexDto,
  ) {
    const item = await this.ingestionService.ingestBibtex(
      workspaceId,
      userId || 'system',
      {
        ...dto,
        idempotencyKey: idempotencyKeyHeader || dto.idempotencyKey,
      },
    );
    return {
      success: true,
      data: item,
    };
  }

  @Post('pdf')
  async ingestPdf(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestPdfDto,
  ) {
    const result = await this.unifiedService.ingest({
      source: 'pdf',
      workspaceId,
      userId,
      fileId: dto.fileId,
      filename: dto.filename,
      collectionId: dto.collectionId,
      overrides: dto.overrides,
      idempotencyKey: idempotencyKeyHeader || dto.idempotencyKey,
    });
    return {
      success: true,
      data: result,
    };
  }
}
