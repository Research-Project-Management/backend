import {
  Injectable,
  Logger,
  Optional,
  Inject,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
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
import {
  CATALOG_FACADE,
  ICatalogFacade,
  ReconcileExtractedCandidatePayload,
} from '@/modules/library/core';
import { createHash, randomUUID } from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';
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
import { isRetryableIngestionError } from '@/modules/library/ingestion/domain/ingestion-error.classifier';

const gzipAsync = promisify(zlib.gzip);

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private readonly metadataResolver: MetadataResolverService;
  private readonly runReporter: IngestionRunReporterService;
  private submissionCountSinceLastGc = 0;
  private static readonly GC_SUBMISSION_INTERVAL = 25;

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
  /**
   * Computes deterministic SHA-256 request payload hash including overrides, collections, and tags.
   */
  public computeRequestHash(envelope: IngestionSubmissionEnvelope): string {
    const projectId = envelope.projectId ?? '';
    return createHash('sha256')
      .update(
        JSON.stringify({
          projectId,
          payload: envelope.payload,
          overrides: envelope.overrides,
          collectionIds: envelope.collectionIds,
          tagIds: envelope.tagIds,
        }),
      )
      .digest('hex');
  }

  /**
   * Primary Fast-Path Submission Entry Point (Async 202 Contract)
   */
  async submit(
    envelope: IngestionSubmissionEnvelope,
    options?: { enqueue?: boolean; skipAsyncDispatch?: boolean },
  ): Promise<IngestionAcceptedResult> {
    if (!envelope.userId) {
      throw new BadRequestException(
        'User context (userId) is required for ingestion submission',
      );
    }

    const projectId = envelope.projectId ?? '';
    const idempotencyKey = envelope.idempotencyKey?.trim();

    const requestHash = this.computeRequestHash(envelope);

    // 1. Idempotency Check & Atomic Claim
    if (idempotencyKey) {
      const existingRun = await this.repo.findRunByIdempotencyKey(
        { userId: envelope.userId, projectId: envelope.projectId ?? null },
        idempotencyKey,
      );

      if (existingRun) {
        if (existingRun.inputHash !== requestHash) {
          throw new UnprocessableEntityException(
            'Idempotency key reused with different request payload',
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
      this.storagePort?.uploadFile
    ) {
      try {
        const rawBuffer = Buffer.from(envelope.payload.content, 'utf-8');
        const compressed = await gzipAsync(rawBuffer);
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

      // If a concurrent request inserted with the exact same (userId, projectId, idempotencyKey), Prisma throws P2002
      if (idempotencyKey && isP2002) {
        const raceRun = await this.repo.findRunByIdempotencyKey(
          { userId: envelope.userId, projectId: envelope.projectId ?? null },
          idempotencyKey,
        );
        if (raceRun) {
          if (raceRun.inputHash !== requestHash) {
            throw new UnprocessableEntityException(
            'Idempotency key reused with different request payload',
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
    const shouldEnqueue =
      (options?.enqueue ?? true) && !options?.skipAsyncDispatch;
    if (shouldEnqueue) {
      void this.queue
        .enqueue(runId, projectId, envelopeToPersist)
        .catch(async (enqueueErr: unknown) => {
          const errMsg =
            enqueueErr instanceof Error
              ? enqueueErr.message
              : String(enqueueErr);
          this.logger.error(
            `Failed to enqueue ingestion run ${runId}: ${errMsg}`,
          );
          await this.repo
            .updateRunStatus(
              { userId: envelope.userId, projectId: envelope.projectId },
              runId,
              IngestionStatus.FAILED_RETRYABLE,
              {
                lastError: `Failed to enqueue ingestion run: ${errMsg}`,
              },
            )
            .catch((repoErr: unknown) => {
              this.logger.error(
                `Failed to mark run ${runId} as FAILED_RETRYABLE after queue failure: ${repoErr instanceof Error ? repoErr.message : String(repoErr)}`,
              );
            });
        });
    }

    this.submissionCountSinceLastGc++;
    if (
      this.submissionCountSinceLastGc >=
      IngestionService.GC_SUBMISSION_INTERVAL
    ) {
      this.submissionCountSinceLastGc = 0;
      void this.runMaintenanceGc().catch(() => undefined);
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
    userIdOrScopeId: string,
    runId: string,
    projectId?: string,
  ): Promise<IngestionRunSnapshot> {
    return this.runReporter.getRunStatus(userIdOrScopeId, runId, projectId);
  }

  async getRunProgress(
    userIdOrScopeId: string,
    runId: string,
    projectId?: string,
  ): Promise<IngestionRunProgressResult> {
    return this.runReporter.getRunProgress(userIdOrScopeId, runId, projectId);
  }

  async retryRun(
    userIdOrScopeId: string,
    runId: string,
    projectId?: string,
  ): Promise<{
    runId: string;
    status: IngestionStatus;
    message: string;
  }> {
    return this.runReporter.retryRun(userIdOrScopeId, runId, projectId);
  }

  /**
   * Unified synchronous/direct ingestion entry point.
   * Delegates to modern IngestionPipelineRunner via mapped envelope.
   */
  async ingest(command: IngestionCommand): Promise<IngestionResult> {
    const projectId = command.projectId || command.userId || '';
    const envelope = this.mapCommandToEnvelope(projectId, command);

    const submissionRes = await this.submit(envelope, {
      enqueue: false,
      skipAsyncDispatch: true,
    });
    const runId = submissionRes.runId;

    if (
      submissionRes.deduplicated &&
      !submissionRes.existingItemId &&
      (submissionRes.status === IngestionStatus.RUNNING ||
        submissionRes.status === IngestionStatus.PENDING)
    ) {
      return {
        runId,
        status: 'processing',
        attachmentIds: [],
        deduplicated: true,
      };
    }

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
      const alreadyTransitioned = Boolean(
        (err as { __runStatusTransitioned?: boolean } | null | undefined)
          ?.__runStatusTransitioned,
      );
      if (!alreadyTransitioned) {
        const isRetryable = this.isRetryableIngestionError(err, envelope);
        const targetStatus = isRetryable
          ? IngestionStatus.FAILED_RETRYABLE
          : IngestionStatus.FAILED_FINAL;
        await this.repo
          .updateRunStatus(projectId, runId, targetStatus, {
            lastError: errMsg,
          })
          .catch((repoErr: unknown) => {
            this.logger.error(
              `Failed to update run status to ${targetStatus} for run ${runId}: ${repoErr instanceof Error ? repoErr.message : String(repoErr)}`,
            );
          });
      }

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
        updatedRun?.status === IngestionStatus.FAILED_FINAL ||
        updatedRun?.status === IngestionStatus.FAILED_RETRYABLE
          ? 'failed'
          : 'completed',
      itemId,
      attachmentIds: [],
      deduplicated: false,
      item,
      errorMessage: updatedRun?.lastError ?? undefined,
    };
  }

  private isRetryableIngestionError(
    err: unknown,
    envelope?: IngestionSubmissionEnvelope,
  ): boolean {
    return isRetryableIngestionError(err, envelope, this.pipeline);
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
      case 'csl_json':
        payload = {
          kind: 'RECORD',
          format: 'CSL_JSON',
          content: ('content' in command ? command.content : '') || '',
        };
        break;
      case 'endnote_xml':
        payload = {
          kind: 'RECORD',
          format: 'ENDNOTE_XML',
          content: ('content' in command ? command.content : '') || '',
        };
        break;
      case 'mods':
        payload = {
          kind: 'RECORD',
          format: 'MODS',
          content: ('content' in command ? command.content : '') || '',
        };
        break;
      case 'zotero_rdf':
      case 'rdf':
        payload = {
          kind: 'RECORD',
          format: 'ZOTERO_RDF',
          content: ('content' in command ? command.content : '') || '',
        };
        break;
      case 'medline':
      case 'nbib':
        payload = {
          kind: 'RECORD',
          format: 'MEDLINE',
          content: ('content' in command ? command.content : '') || '',
        };
        break;
      case 'csv':
        payload = {
          kind: 'RECORD',
          format: 'CSV',
          content: ('content' in command ? command.content : '') || '',
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

    const rawOverrides =
      'overrides' in command &&
      command.overrides &&
      typeof command.overrides === 'object'
        ? (command.overrides as Record<string, unknown>)
        : undefined;
    const overrideCollectionIds = Array.isArray(rawOverrides?.collectionIds)
      ? (rawOverrides.collectionIds as string[])
      : typeof rawOverrides?.collectionId === 'string' &&
          rawOverrides.collectionId.trim()
        ? [rawOverrides.collectionId.trim()]
        : undefined;
    const overrideTagIds = Array.isArray(rawOverrides?.tagIds)
      ? (rawOverrides.tagIds as string[])
      : undefined;

    return {
      projectId,
      userId: command.userId,
      idempotencyKey: command.idempotencyKey,
      payload,
      collectionIds: command.collectionId
        ? [command.collectionId]
        : overrideCollectionIds,
      tagIds: overrideTagIds,
      overrides: rawOverrides,
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
   * Scheduled/triggered maintenance GC that reaps:
   * 1. Offloaded claim-check blobs (`inputParams.payload.fileId`) when an IngestionRun reaches terminal status,
   * 2. Expired CapturePreview rows and their unconfirmed PDF blobs (`pdfFileId` / `fileId`) from storagePort,
   * 3. Old terminal IngestionRun rows (> 7 days).
   */
  async runMaintenanceGc(options?: {
    envelope?: IngestionSubmissionEnvelope;
    retentionDays?: number;
  }): Promise<{
    deletedClaimCheckBlob: boolean;
    expiredPreviewsDeleted: number;
    purgedRuns: number;
  }> {
    let deletedClaimCheckBlob = false;
    const payload = options?.envelope?.payload;
    const claimCheckFileId =
      payload?.kind === 'RECORD' &&
      payload.isOffloaded === true &&
      typeof payload.fileId === 'string'
        ? payload.fileId
        : undefined;

    if (claimCheckFileId && this.storagePort?.deleteFile) {
      try {
        await this.storagePort.deleteFile(claimCheckFileId);
        deletedClaimCheckBlob = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[MaintenanceGC] Failed to delete claim-check blob ${claimCheckFileId}: ${msg}`,
        );
      }
    }

    let expiredPreviewsDeleted = 0;
    try {
      expiredPreviewsDeleted = await this.urlCapture.cleanupExpiredPreviews(
        options?.retentionDays ?? 0,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[MaintenanceGC] Failed to reap expired capture previews: ${msg}`,
      );
    }

    let purgedRuns = 0;
    try {
      const retentionDays = options?.retentionDays ?? 7;
      purgedRuns = await this.repo.purgeOldRuns(retentionDays);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[MaintenanceGC] Failed to purge old ingestion runs: ${msg}`,
      );
    }

    return {
      deletedClaimCheckBlob,
      expiredPreviewsDeleted,
      purgedRuns,
    };
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

  async reconcileExtractedCandidate(
    payload: ReconcileExtractedCandidatePayload,
  ): Promise<{ updated: boolean; updatedFields: string[]; rejectedCitedDoi?: string }> {
    return this.metadataResolver.reconcileExtractedCandidate(payload);
  }
}
