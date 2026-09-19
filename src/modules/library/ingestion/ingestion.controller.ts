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
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '../../../modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '../../../modules/iam/authz/decorators/role.decorator';
import { IngestionPort, INGESTION_PORT } from './types/ingestion.types';
import { IngestionService } from './ingestion.service';
import { IngestionSubmissionDto } from './dto/submission.dto';
import { UnifiedIngestionDto } from './dto/ingestion.dto';
import { CaptureUrlDto, ConfirmCapturedUrlDto } from './dto/capture-url.dto';

import { isUUID } from 'class-validator';

const toValidProjectId = (val?: string): string | undefined =>
  val && val !== 'me' && val !== 'user' && val !== 'personal' && isUUID(val)
    ? val
    : undefined;

@Controller([
  'api/v1/library/ingestion',
  'api/v1/projects/:projectId/library/ingestion',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
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
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: IngestionSubmissionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId || dto.projectId,
    );

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

    return this.ingestionService.submit({
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

  /**
   * Ingestion Run Status Endpoint
   */
  @Get('status/:runId')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getStatus(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
  ) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.ingestionService.getRunStatus(userId, runId);
  }

  /**
   * Ingestion Run Real-time Progress Endpoint (Zotero-style progress modal)
   */
  @Get('status/:runId/progress')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getProgress(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
  ) {
    if (!isUUID(runId)) {
      throw new BadRequestException('Invalid run ID');
    }
    return this.ingestionService.getRunProgress(userId, runId);
  }

  /**
   * Ingestion Run Retry Endpoint
   */
  @Post('retry/:runId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  async retry(
    @CurrentUser('id') userId: string,
    @Param('runId') runId: string,
  ) {
    return this.ingestionService.retryRun(userId, runId);
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  async ingestUnified(
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() dto: UnifiedIngestionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveIdempotencyKey = idempotencyKeyHeader || dto.idempotencyKey;
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId || (dto as any).projectId,
    );
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

    return this.unifiedService.ingest(command);
  }

  @Post('capture-url')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async captureUrl(
    @CurrentUser('id') userId: string,
    @Body() dto: CaptureUrlDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    return this.ingestionService.captureUrl(dto.url, {
      projectId: effectiveProjectId,
      userId,
    });
  }

  @Post('confirm-url')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async confirmUrl(
    @CurrentUser('id') userId: string,
    @Body() dto: ConfirmCapturedUrlDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId || dto.projectId,
    );
    return this.ingestionService.confirmCapturedUrl(
      effectiveProjectId || userId,
      userId,
      dto,
    );
  }
}
