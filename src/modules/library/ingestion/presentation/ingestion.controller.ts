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
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { IngestionPort, INGESTION_PORT } from '../domain/types/ingestion.types';
import { IngestionService } from '../application/services/ingestion.service';
import { IngestionSubmissionDto } from '../application/dtos/submission.dto';
import { UnifiedIngestionDto } from '../application/dtos/ingestion.dto';
import {
  CaptureUrlDto,
  ConfirmCapturedUrlDto,
} from '../application/dtos/capture-url.dto';

import { isUUID } from 'class-validator';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

// CQRS Use Cases
import { SubmitIngestionUseCase } from '../application/commands/submit-ingestion.use-case';
import { GetIngestionStatusUseCase } from '../application/queries/get-ingestion-status.use-case';
import { GetIngestionProgressUseCase } from '../application/queries/get-ingestion-progress.use-case';
import { RetryIngestionRunUseCase } from '../application/commands/retry-ingestion-run.use-case';
import { CaptureUrlUseCase } from '../application/commands/capture-url.use-case';
import { ConfirmCapturedUrlUseCase } from '../application/commands/confirm-captured-url.use-case';
import { UnifiedIngestUseCase } from '../application/commands/unified-ingest.use-case';

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
  private unifiedServiceInstance?: IngestionPort;
  private ingestionServiceInstance?: IngestionService;

  constructor(
    unifiedService: IngestionPort,
    ingestionService: IngestionService,
  );
  constructor(
    submitIngestionUseCase: SubmitIngestionUseCase,
    getIngestionStatusUseCase: GetIngestionStatusUseCase,
    getIngestionProgressUseCase: GetIngestionProgressUseCase,
    retryIngestionRunUseCase: RetryIngestionRunUseCase,
    captureUrlUseCase: CaptureUrlUseCase,
    confirmCapturedUrlUseCase: ConfirmCapturedUrlUseCase,
    unifiedIngestUseCase: UnifiedIngestUseCase,
    unifiedService?: IngestionPort,
    ingestionService?: IngestionService,
  );
  constructor(
    @Optional()
    private readonly submitIngestionUseCase?: any,
    @Optional()
    private readonly getIngestionStatusUseCase?: any,
    @Optional()
    private readonly getIngestionProgressUseCase?: GetIngestionProgressUseCase,
    @Optional()
    private readonly retryIngestionRunUseCase?: RetryIngestionRunUseCase,
    @Optional() private readonly captureUrlUseCase?: CaptureUrlUseCase,
    @Optional()
    private readonly confirmCapturedUrlUseCase?: ConfirmCapturedUrlUseCase,
    @Optional() private readonly unifiedIngestUseCase?: UnifiedIngestUseCase,
    @Optional()
    @Inject(INGESTION_PORT)
    private readonly unifiedService?: IngestionPort,
    @Optional()
    private readonly ingestionService?: IngestionService,
  ) {
    if (
      submitIngestionUseCase &&
      !('execute' in (submitIngestionUseCase as any))
    ) {
      this.unifiedServiceInstance = submitIngestionUseCase as any;
      this.ingestionServiceInstance = getIngestionStatusUseCase as any;
    } else {
      this.unifiedServiceInstance = unifiedService;
      this.ingestionServiceInstance = ingestionService;
    }
  }

  private get effectiveUnifiedService(): IngestionPort | undefined {
    return this.unifiedServiceInstance ?? this.unifiedService;
  }

  private get effectiveIngestionService(): IngestionService | undefined {
    return this.ingestionServiceInstance ?? this.ingestionService;
  }

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

    if (this.submitIngestionUseCase?.execute) {
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

    return this.effectiveIngestionService!.submit({
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
    if (this.getIngestionStatusUseCase?.execute) {
      return this.getIngestionStatusUseCase.execute({ userId, runId });
    }
    return this.effectiveIngestionService!.getRunStatus(userId, runId);
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
    if (this.getIngestionProgressUseCase?.execute) {
      return this.getIngestionProgressUseCase.execute({ userId, runId });
    }
    return this.effectiveIngestionService!.getRunProgress(userId, runId);
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
    if (this.retryIngestionRunUseCase?.execute) {
      return this.retryIngestionRunUseCase.execute({ userId, runId });
    }
    return this.effectiveIngestionService!.retryRun(userId, runId);
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

    if (this.unifiedIngestUseCase?.execute) {
      return this.unifiedIngestUseCase.execute(command);
    }
    return this.effectiveUnifiedService!.ingest(command);
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
    if (this.captureUrlUseCase?.execute) {
      return this.captureUrlUseCase.execute({
        url: dto.url,
        scope: {
          projectId: effectiveProjectId,
          userId,
        },
      });
    }
    return this.effectiveIngestionService!.captureUrl(dto.url, {
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
    if (this.confirmCapturedUrlUseCase?.execute) {
      return this.confirmCapturedUrlUseCase.execute({
        scopeId: effectiveProjectId || userId,
        userId,
        dto,
      });
    }
    return this.effectiveIngestionService!.confirmCapturedUrl(
      effectiveProjectId || userId,
      userId,
      dto,
    );
  }
}
