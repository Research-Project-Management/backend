import {
  Injectable,
  Logger,
  Optional,
  Inject,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import {
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
  SubmissionPayload,
} from '@/modules/library/ingestion/types/submission.types';
import {
  IngestionCommand,
  IngestionResult,
  IngestionRunSnapshot,
} from '@/modules/library/ingestion/types/ingestion.types';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { IngestionStatus, IngestionRun, Prisma } from '@prisma/client';
import { PipelineService } from './pipeline.service';
import { QueueService } from './queue.service';
import { UrlCaptureService } from './url-capture.service';
import { ConfirmCapturedUrlDto } from '@/modules/library/ingestion/dto/capture-url.dto';
import { CATALOG_FACADE, ICatalogFacade } from '@/modules/library/core';
import { createHash, randomUUID } from 'crypto';
import zlib from 'zlib';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  METADATA_PORT,
  MetadataPort,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  MetadataResolverService,
  ReResolveMetadataOptions,
  ReResolveMetadataResult,
} from './metadata-resolver.service';
import {
  IngestionRunReporterService,
  IngestionRunProgressResult,
} from './ingestion-run-reporter.service';

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private readonly metadataResolver: MetadataResolverService;
  private readonly runReporter: IngestionRunReporterService;

  constructor(
    private readonly repo: IngestionRepository,
    private readonly pipeline: PipelineService,
    private readonly queue: QueueService,
    private readonly urlCapture: UrlCaptureService,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    @Inject(METADATA_PORT)
    private readonly metadataService?: MetadataPort,
    @Optional()
    metadataResolver?: MetadataResolverService,
    @Optional()
    runReporter?: IngestionRunReporterService,
  ) {
    this.metadataResolver =
      metadataResolver ??
      new MetadataResolverService(this.catalogGateway, this.metadataService);
    this.runReporter =
      runReporter ?? new IngestionRunReporterService(this.repo, this.queue);
  }

  /**
   * Primary Fast-Path Submission Entry Point (Async 202 Contract)
   */
  async submit(
    envelope: IngestionSubmissionEnvelope,
    options?: { enqueue?: boolean },
  ): Promise<IngestionAcceptedResult> {
    if (!envelope.userId) {
      throw new BadRequestException(
        'User context (userId) is required for ingestion submission',
      );
    }

    const projectId = envelope.projectId ?? '';
    const idempotencyKey = envelope.idempotencyKey?.trim();

    const requestHash = createHash('sha256')
      .update(JSON.stringify({ projectId, payload: envelope.payload }))
      .digest('hex');

    // 1. Idempotency Check & Atomic Claim
    if (idempotencyKey) {
      const existingRun = await this.repo.findRunByIdempotencyKey(
        { userId: envelope.userId, projectId: envelope.projectId },
        idempotencyKey,
      );

      if (existingRun) {
        if (existingRun.inputHash !== requestHash) {
          throw new ConflictException(
            `Idempotency key "${idempotencyKey}" was already used with a different request payload`,
          );
        }

        return {
          runId: existingRun.id,
          statusUrl: `/api/v1/library/ingestion/status/${existingRun.id}`,
          acceptedAt: existingRun.startedAt
            ? existingRun.startedAt.toISOString()
            : new Date().toISOString(),
          requestHash,
          status: existingRun.status,
          existingItemId: existingRun.itemId ?? undefined,
          deduplicated: true,
        };
      }
    }

    // Claim Check Pattern: If record payload exceeds 32KB, offload compressed payload to Storage
    let effectivePayload = envelope.payload;
    if (
      envelope.payload.kind === 'RECORD' &&
      envelope.payload.content &&
      envelope.payload.content.length > 32 * 1024 &&
      typeof this.storagePort?.uploadFile === 'function'
    ) {
      try {
        const rawBuffer = Buffer.from(envelope.payload.content, 'utf-8');
        const compressed = zlib.gzipSync(rawBuffer);
        const uploadResult = await this.storagePort.uploadFile({
          userId: envelope.userId,
          projectId: envelope.projectId || undefined,
          filename: `ingest_${envelope.payload.format.toLowerCase()}_${randomUUID().slice(0, 8)}.json.gz`,
          buffer: compressed,
          mimeType: 'application/gzip',
          source: 'ingestion.claim_check',
        });

        if (uploadResult?.fileId) {
          effectivePayload = {
            kind: 'RECORD',
            format: envelope.payload.format,
            isOffloaded: true,
            fileId: uploadResult.fileId,
            storageKey: uploadResult.path,
            byteSize: compressed.length,
            uncompressedSize: rawBuffer.length,
          };
          this.logger.log(
            `[ClaimCheck] Offloaded large ${envelope.payload.format} record payload (${rawBuffer.length}B -> ${compressed.length}B compressed) to storage fileId=${uploadResult.fileId}`,
          );
        }
      } catch (offloadErr: unknown) {
        const offloadMsg =
          offloadErr instanceof Error ? offloadErr.message : String(offloadErr);
        this.logger.warn(
          `[ClaimCheck] Failed to offload record payload to storage: ${offloadMsg}. Falling back to inline.`,
        );
      }
    }

    const envelopeToPersist: IngestionSubmissionEnvelope = {
      ...envelope,
      payload: effectivePayload,
    };

    // 2. Create IngestionRun Record with Race Condition Protection (P2002)
    let run: IngestionRun;
    try {
      run = await this.repo.createRun(
        { userId: envelope.userId, projectId },
        {
          inputParams: envelopeToPersist as unknown as Prisma.InputJsonValue,
          inputHash: requestHash,
          idempotencyKey,
          contractVersion: envelope.contractVersion || '1.0.0',
        },
      );
    } catch (err: unknown) {
      const errRecord =
        err && typeof err === 'object'
          ? (err as Record<string, unknown>)
          : null;
      const isP2002 =
        errRecord?.code === 'P2002' ||
        (err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002') ||
        (err instanceof Error && err.message.includes('Unique constraint'));

      // If a concurrent request inserted with the exact same (userId, idempotencyKey), Prisma throws P2002
      if (idempotencyKey && isP2002) {
        const raceRun = await this.repo.findRunByIdempotencyKey(
          { userId: envelope.userId, projectId: envelope.projectId },
          idempotencyKey,
        );
        if (raceRun) {
          if (raceRun.inputHash !== requestHash) {
            throw new ConflictException(
              `Idempotency key "${idempotencyKey}" was already used with a different request payload`,
            );
          }
          return {
            runId: raceRun.id,
            statusUrl: `/api/v1/library/ingestion/status/${raceRun.id}`,
            acceptedAt: raceRun.startedAt
              ? raceRun.startedAt.toISOString()
              : new Date().toISOString(),
            requestHash,
            status: raceRun.status,
            existingItemId: raceRun.itemId ?? undefined,
            deduplicated: true,
          };
        }
      }
      throw err;
    }

    const runId = run?.id || randomUUID();
    const statusUrl = `/api/v1/library/ingestion/status/${runId}`;

    // 3. Return the durable run immediately and dispatch to IngestionQueueService
    // for bounded concurrency and worker resilience (unless direct synchronous execution is requested).
    const shouldEnqueue = options?.enqueue ?? true;
    if (shouldEnqueue) {
      void this.queue.enqueue(runId, projectId, envelopeToPersist);
    }

    return {
      runId,
      statusUrl,
      acceptedAt: run?.startedAt
        ? run.startedAt.toISOString()
        : new Date().toISOString(),
      requestHash,
      status: run?.status || IngestionStatus.PENDING,
      existingItemId: run?.itemId ?? undefined,
      deduplicated: false,
    };
  }

  /**
   * Executes the multi-stage ingestion pipeline.
   * Delegated to PipelineService.
   */
  async executePipeline(
    runId: string,
    projectId: string,
    envelope: IngestionSubmissionEnvelope,
  ): Promise<void> {
    return this.pipeline.executePipeline(runId, projectId, envelope);
  }

  async getRunStatus(
    /** scopeId: may be userId (user library) or projectId — repo ignores it, kept for interface parity */
    scopeId: string,
    runId: string,
  ): Promise<IngestionRunSnapshot> {
    return this.runReporter.getRunStatus(scopeId, runId);
  }

  async getRunProgress(
    /** scopeId: may be userId (user library) or projectId — repo ignores it, kept for interface parity */
    scopeId: string,
    runId: string,
  ): Promise<IngestionRunProgressResult> {
    return this.runReporter.getRunProgress(scopeId, runId);
  }

  async retryRun(
    /** scopeId: may be userId (user library) or projectId — repo ignores it, kept for interface parity */
    scopeId: string,
    runId: string,
  ): Promise<{
    runId: string;
    status: IngestionStatus;
    message: string;
  }> {
    return this.runReporter.retryRun(scopeId, runId);
  }

  /**
   * Unified synchronous/direct ingestion entry point.
   * Delegates to modern IngestionPipelineRunner via mapped envelope.
   */
  async ingest(command: IngestionCommand): Promise<IngestionResult> {
    const projectId = command.projectId || command.userId || '';
    const envelope = this.mapCommandToEnvelope(projectId, command);

    const submissionRes = await this.submit(envelope, { enqueue: false });
    const runId = submissionRes.runId;

    if (submissionRes.deduplicated && submissionRes.existingItemId) {
      const item = this.catalogGateway
        ? await this.catalogGateway
            .getItem(
              envelope.userId!,
              submissionRes.existingItemId,
              projectId || undefined,
            )
            .catch(() => undefined)
        : undefined;

      return {
        runId,
        status: 'completed',
        itemId: submissionRes.existingItemId,
        attachmentIds: [],
        deduplicated: true,
        item,
      };
    }

    try {
      await this.pipeline.executePipeline(runId, projectId, envelope);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Ingestion pipeline failed for run ${runId}: ${errMsg}`,
      );
      await this.repo
        .updateRunStatus(projectId, runId, IngestionStatus.FAILED_FINAL, {
          lastError: errMsg,
        })
        .catch((repoErr: unknown) => {
          this.logger.error(
            `Failed to update run status to FAILED_FINAL for run ${runId}: ${repoErr instanceof Error ? repoErr.message : String(repoErr)}`,
          );
        });

      return {
        runId,
        status: 'failed',
        attachmentIds: [],
        deduplicated: false,
        errorMessage: errMsg || 'Pipeline execution failed',
      };
    }

    const updatedRun = await this.repo.findRunById(projectId, runId);
    const itemId = updatedRun?.itemId ?? undefined;
    const item =
      itemId && this.catalogGateway
        ? await this.catalogGateway
            .getItem(envelope.userId!, itemId, projectId || undefined)
            .catch(() => undefined)
        : undefined;

    return {
      runId,
      status:
        updatedRun?.status === IngestionStatus.FAILED_FINAL
          ? 'failed'
          : 'completed',
      itemId,
      attachmentIds: [],
      deduplicated: false,
      item,
      errorMessage: updatedRun?.lastError ?? undefined,
    };
  }

  private mapCommandToEnvelope(
    projectId: string,
    command: IngestionCommand,
  ): IngestionSubmissionEnvelope {
    let payload: SubmissionPayload;
    switch (command.source) {
      case 'doi':
        payload = {
          kind: 'IDENTIFIER',
          identifierType: 'DOI',
          value: command.doi || '',
        };
        break;
      case 'arxiv':
        payload = {
          kind: 'IDENTIFIER',
          identifierType: 'ARXIV',
          value: ('arxivId' in command ? command.arxivId : '') || '',
        };
        break;
      case 'pmid':
        payload = {
          kind: 'IDENTIFIER',
          identifierType: 'PMID',
          value: ('pmid' in command ? command.pmid : '') || '',
        };
        break;
      case 'isbn':
        payload = {
          kind: 'IDENTIFIER',
          identifierType: 'ISBN',
          value: ('isbn' in command ? command.isbn : '') || '',
        };
        break;
      case 'url':
        payload = {
          kind: 'URL',
          url: command.url || '',
          previewToken:
            'previewToken' in command ? command.previewToken : undefined,
        };
        break;
      case 'bibtex':
        payload = {
          kind: 'RECORD',
          format: 'BIBTEX',
          content: command.content || '',
        };
        break;
      case 'ris':
        payload = {
          kind: 'RECORD',
          format: 'RIS',
          content: command.content || '',
        };
        break;
      case 'pdf':
        payload = {
          kind: 'FILE',
          fileId: command.fileId || '',
          filename: command.filename,
        };
        break;
      case 'zotero':
        payload = {
          kind: 'CONNECTOR',
          connectionId:
            ('connectionId' in command ? command.connectionId : '') || '',
          externalObjectId:
            ('externalItemKey' in command ? command.externalItemKey : '') || '',
          externalVersion: '1',
        };
        break;
      default:
        throw new BadRequestException(
          `Unsupported ingestion source: ${String((command as { source?: unknown }).source)}`,
        );
    }

    return {
      projectId,
      userId: command.userId,
      idempotencyKey: command.idempotencyKey,
      payload,
      collectionIds: command.collectionId ? [command.collectionId] : undefined,
      overrides: 'overrides' in command ? command.overrides : undefined,
    };
  }

  async captureUrl(
    url: string,
    contextOrProjectId:
      | string
      | {
          projectId?: string;
          userId?: string;
        },
  ) {
    return this.urlCapture.captureUrl(url, contextOrProjectId);
  }

  async confirmCapturedUrl(
    projectId: string,
    userId: string,
    dto: ConfirmCapturedUrlDto,
  ) {
    return this.urlCapture.confirmCapturedUrl(projectId, userId, dto);
  }

  async cleanupExpiredPreviews(retentionDays = 7): Promise<number> {
    return this.urlCapture.cleanupExpiredPreviews(retentionDays);
  }

  /**
   * Re-resolves bibliographic metadata for an existing library item on demand.
   * Queries Open Academic Mirrors (CrossRef, arXiv, PubMed, EuropePMC) and harmonizes fields.
   */
  async reResolveMetadata(
    userId: string,
    itemId: string,
    options?: ReResolveMetadataOptions,
    projectId?: string,
  ): Promise<ReResolveMetadataResult> {
    return this.metadataResolver.reResolveMetadata(
      userId,
      itemId,
      options,
      projectId,
    );
  }
}
