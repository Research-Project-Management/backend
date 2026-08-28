import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { IngestionService } from './ingestion.service';
import {
  StartIngestionDto,
  IngestDoiDto,
  IngestBibtexDto,
  IngestPdfDto,
  UnifiedIngestionDto,
} from './dto/ingestion.dto';
import { CaptureUrlDto, ConfirmCapturedUrlDto } from './dto/capture-url.dto';

@Controller('api/v1/workspaces/:workspaceId/library/ingestion')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  /**
   * Unified Ingestion Endpoint (Supports DOI, URL, BibTeX, PDF, Zotero)
   */
  @Post(['', 'unified'])
  @HttpCode(HttpStatus.OK)
  async ingestUnified(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UnifiedIngestionDto,
  ) {
    let command: any;

    switch (dto.source) {
      case 'doi':
        command = {
          source: 'doi',
          workspaceId,
          userId,
          doi: dto.doi || '',
          collectionId: dto.collectionId,
          idempotencyKey: dto.idempotencyKey,
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
          idempotencyKey: dto.idempotencyKey,
        };
        break;

      case 'bibtex':
        command = {
          source: 'bibtex',
          workspaceId,
          userId,
          content: dto.content || dto.bibtex || '',
          collectionId: dto.collectionId,
          idempotencyKey: dto.idempotencyKey,
        };
        break;

      case 'pdf':
        command = {
          source: 'pdf',
          workspaceId,
          userId,
          filename: dto.filename,
          fileUrl: dto.fileUrl,
          fileId: dto.fileId,
          mimeType: dto.mimeType,
          size: dto.size,
          fileHash: dto.fileHash,
          collectionId: dto.collectionId,
          extractedMeta: dto.extractedMeta,
          idempotencyKey: dto.idempotencyKey,
        };
        break;

      case 'zotero':
        command = {
          source: 'zotero',
          workspaceId,
          userId,
          connectionId: dto.connectionId || '',
          externalItemKey: dto.externalItemKey || '',
          payload: dto.payload,
          collectionId: dto.collectionId,
          idempotencyKey: dto.idempotencyKey,
        };
        break;

      default:
        command = {
          source: dto.source,
          workspaceId,
          userId,
          idempotencyKey: dto.idempotencyKey,
        };
    }

    const result = await this.ingestionService.ingest(command);
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
    const metadata = await this.ingestionService.captureUrl(dto.url, {
      workspaceId,
      userId,
    });
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
    @Body() dto: StartIngestionDto,
  ) {
    const run = await this.ingestionService.startRun(
      workspaceId,
      userId || 'system',
      dto,
    );
    return {
      success: true,
      data: run,
    };
  }

  @Get('status/:runId')
  async getStatus(@Param('runId') runId: string) {
    const status = await this.ingestionService.getRunStatus(runId);
    return {
      success: true,
      data: status,
    };
  }

  @Post('doi')
  async ingestDoi(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: IngestDoiDto,
  ) {
    const item = await this.ingestionService.ingestDoi(
      workspaceId,
      userId || 'system',
      dto,
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
    @Body() dto: IngestBibtexDto,
  ) {
    const item = await this.ingestionService.ingestBibtex(
      workspaceId,
      userId || 'system',
      dto,
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
    @Body() dto: IngestPdfDto,
  ) {
    const result = await this.ingestionService.ingest({
      source: 'pdf',
      workspaceId,
      userId,
      filename: dto.filename,
      fileUrl: dto.fileUrl,
      fileId: dto.fileId,
      mimeType: dto.mimeType,
      size: dto.size,
      fileHash: dto.fileHash,
      collectionId: dto.collectionId,
      extractedMeta: dto.extractedMeta,
      idempotencyKey: dto.idempotencyKey,
    });
    return {
      success: true,
      data: result,
    };
  }
}
