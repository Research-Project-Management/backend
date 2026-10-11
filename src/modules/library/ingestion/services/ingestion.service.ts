import {
  Injectable,
  Logger,
  Optional,
  Inject,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import {
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
  SubmissionPayload,
} from '../types/submission.types';
import {
  IngestionCommand,
  IngestionResult,
  IngestionPort,
  IngestionRunSnapshot,
} from '../types/ingestion.types';
import { IngestionRepository } from '../repositories/ingestion.repository';
import { IngestionStatus, IngestionRun, Prisma } from '@prisma/client';
import { PipelineService } from './pipeline.service';
import { QueueService } from './queue.service';
import { UrlCaptureService } from './url-capture.service';
import {
  CATALOG_GATEWAY_PORT,
  ICatalogGatewayPort,
} from '../types/catalog-gateway.types';
import { createHash, randomUUID } from 'crypto';
import zlib from 'zlib';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';

@Injectable()
export class IngestionService implements IngestionPort {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly repo: IngestionRepository,
    private readonly pipeline: PipelineService,
    private readonly queue: QueueService,
    private readonly urlCapture: UrlCaptureService,
    @Optional()
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway?: ICatalogGatewayPort,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

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
      } catch (offloadErr: any) {
        this.logger.warn(
          `[ClaimCheck] Failed to offload record payload to storage: ${offloadErr?.message}. Falling back to inline.`,
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
    } catch (err: any) {
      // If a concurrent request inserted with the exact same (userId, idempotencyKey), Prisma throws P2002
      if (
        idempotencyKey &&
        (err?.code === 'P2002' || err?.message?.includes('Unique constraint'))
      ) {
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

  private parseExecutionLog(executionLog: unknown): Record<string, any> {
    if (
      executionLog &&
      typeof executionLog === 'object' &&
      !Array.isArray(executionLog)
    ) {
      return executionLog as Record<string, any>;
    }
    return {};
  }

  async getRunStatus(
    /** scopeId: may be userId (user library) or projectId — repo ignores it, kept for interface parity */
    scopeId: string,
    runId: string,
  ): Promise<IngestionRunSnapshot> {
    const run = await this.repo.findRunById(scopeId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }

    const log = this.parseExecutionLog(run.executionLog);
    const logItem =
      log.item ||
      (Array.isArray(log.items) && log.items.length > 0
        ? { id: log.items[0].itemId || run.itemId, title: log.items[0].title }
        : null);
    const resolvedItem = run.item || logItem || null;
    const title =
      run.item?.title ||
      log.currentTitle ||
      (Array.isArray(log.items) && log.items[0]?.title) ||
      log.item?.title ||
      null;
    const itemId =
      run.itemId ||
      resolvedItem?.id ||
      (Array.isArray(log.items) && log.items[0]?.itemId) ||
      null;

    return {
      ...run,
      itemId,
      item: resolvedItem
        ? { ...resolvedItem, title: resolvedItem.title || title }
        : null,
      title,
    } as unknown as IngestionRunSnapshot;
  }

  async getRunProgress(
    /** scopeId: may be userId (user library) or projectId — repo ignores it, kept for interface parity */
    scopeId: string,
    runId: string,
  ): Promise<{
    runId: string;
    projectId: string;
    status: string;
    currentStage?: string;
    total: number;
    processed: number;
    percentage: number;
    succeeded: number;
    duplicates: number;
    failed: number;
    currentTitle?: string;
    items: Array<{
      title: string;
      status: 'SUCCEEDED' | 'DUPLICATE' | 'FAILED';
      itemId?: string;
      error?: string;
    }>;
    startedAt: string;
    completedAt?: string;
  }> {
    const run = await this.repo.findRunById(scopeId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }

    const log = this.parseExecutionLog(run.executionLog);
    const total = Number(log.total) || 1;
    const isCompleted = run.status === IngestionStatus.COMPLETED;
    const processed = Number(log.processed) || (isCompleted ? total : 0);
    const succeeded =
      Number(log.succeeded) || (isCompleted && !log.duplicates ? 1 : 0);
    const duplicates = Number(log.duplicates) || 0;
    const failed =
      Number(log.failed) ||
      (run.status === IngestionStatus.FAILED_FINAL ||
      run.status === IngestionStatus.FAILED_RETRYABLE
        ? 1
        : 0);
    const percentage =
      typeof log.percentage === 'number'
        ? log.percentage
        : isCompleted
          ? 100
          : Math.min(Math.round((processed / total) * 100), 99);

    const title =
      run.item?.title ||
      log.currentTitle ||
      (Array.isArray(log.items) && log.items[0]?.title) ||
      log.item?.title ||
      undefined;

    const items =
      Array.isArray(log.items) && log.items.length > 0
        ? log.items
        : title
          ? [
              {
                title,
                status: isCompleted ? 'SUCCEEDED' : 'FAILED',
                itemId: run.itemId || undefined,
              },
            ]
          : [];

    return {
      runId: run.id,
      projectId: scopeId,
      status: String(run.status),
      currentStage: run.currentStage || undefined,
      total,
      processed,
      percentage,
      succeeded,
      duplicates,
      failed,
      currentTitle: title,
      items,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString(),
    };
  }

  async retryRun(
    /** scopeId: may be userId (user library) or projectId — repo ignores it, kept for interface parity */
    scopeId: string,
    runId: string,
  ): Promise<any> {
    const run = await this.repo.findRunById(scopeId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }

    await this.repo.updateRunStatus(scopeId, runId, IngestionStatus.PENDING);

    const envelope = run.inputParams as unknown as IngestionSubmissionEnvelope;
    if (envelope && typeof envelope === 'object') {
      void this.queue.enqueue(runId, scopeId, {
        ...envelope,
        projectId: scopeId,
      });
      this.logger.log(
        `Retry initiated and re-enqueued for run ${runId} (scope: ${scopeId})`,
      );
    } else {
      this.logger.warn(
        `Retry requested for run ${runId}, but inputParams is missing or invalid.`,
      );
    }

    return {
      runId,
      status: IngestionStatus.PENDING,
      message: 'Ingestion run retry initiated and enqueued',
    };
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
    } catch (err: any) {
      this.logger.error(
        `Ingestion pipeline failed for run ${runId}: ${err?.message || err}`,
      );
      await this.repo
        .updateRunStatus(projectId, runId, IngestionStatus.FAILED_FINAL, {
          lastError: err?.message || 'Unknown failure',
        })
        .catch(() => {});

      return {
        runId,
        status: 'failed',
        attachmentIds: [],
        deduplicated: false,
        errorMessage: err?.message || 'Pipeline execution failed',
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
          value: command.doi,
        };
        break;
      case 'url':
        payload = {
          kind: 'URL',
          url: command.url,
          previewToken: command.previewToken,
        };
        break;
      case 'bibtex':
        payload = {
          kind: 'RECORD',
          format: 'BIBTEX',
          content: command.content,
        };
        break;
      case 'pdf':
        payload = {
          kind: 'FILE',
          fileId: command.fileId,
          filename: command.filename,
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

  // ── Backward Compatibility Convenience Methods ────────────────────────────

  async ingestDoi(projectId: string, userId: string, dto: any) {
    const res = await this.ingest({
      source: 'doi',
      projectId,
      userId,
      doi: dto.doi,
      collectionId: dto.collectionId,
      idempotencyKey: dto.idempotencyKey,
    });
    return res.item || { id: res.itemId, runId: res.runId };
  }

  async ingestBibtex(projectId: string, userId: string, dto: any) {
    const res = await this.ingest({
      source: 'bibtex',
      projectId,
      userId,
      content: dto.bibtex || dto.content,
      collectionId: dto.collectionId,
      idempotencyKey: dto.idempotencyKey,
    });
    return res.item || { id: res.itemId, runId: res.runId };
  }

  async startRun(projectId: string, userId: string, dto: any) {
    const res = await this.ingest({
      source: dto.source || 'doi',
      projectId,
      userId,
      doi: dto.doi || '',
      content: dto.content || '',
      idempotencyKey: dto.idempotencyKey,
    });
    return { runId: res.runId, status: res.status };
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

  async confirmCapturedUrl(projectId: string, userId: string, dto: any) {
    return this.urlCapture.confirmCapturedUrl(projectId, userId, dto);
  }

  async cleanupExpiredPreviews(retentionDays = 7): Promise<number> {
    return this.urlCapture.cleanupExpiredPreviews(retentionDays);
  }
}
