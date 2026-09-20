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
} from '../../domain/types/submission.types';
import {
  IngestionCommand,
  IngestionResult,
  IngestionPort,
  IngestionRunSnapshot,
} from '../../domain/types/ingestion.types';
import { IngestionRepository } from '../../infrastructure/repositories/ingestion.repository';
import { IngestionStatus, Prisma } from '@prisma/client';
import { PipelineService } from './pipeline.service';
import { QueueService } from './queue.service';
import { UrlCaptureService } from './url-capture.service';
import {
  BIBLIOGRAPHY_FACADE,
  IBibliographyFacade,
  CATALOG_FACADE,
  ICatalogFacade,
} from '../../../bibliography/bibliography.facade';
import { createHash, randomUUID } from 'crypto';

@Injectable()
export class IngestionService implements IngestionPort {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly repo: IngestionRepository,
    private readonly pipeline: PipelineService,
    private readonly queue: QueueService,
    private readonly urlCapture: UrlCaptureService,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogFacade?: ICatalogFacade,
  ) {}

  /**
   * Primary Fast-Path Submission Entry Point (Async 202 Contract)
   */
  async submit(
    envelope: IngestionSubmissionEnvelope,
  ): Promise<IngestionAcceptedResult> {
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
          status: existingRun.status as any,
          existingItemId: existingRun.itemId ?? undefined,
          deduplicated: true,
        };
      }
    }

    // 2. Create IngestionRun Record
    const run = await this.repo.createRun(projectId, {
      requesterId: envelope.userId,
      inputParams: envelope as unknown as Prisma.InputJsonValue,
      inputHash: requestHash,
      idempotencyKey,
      contractVersion: envelope.contractVersion || '1.0.0',
    });

    const runId = run?.id || randomUUID();
    const statusUrl = `/api/v1/library/ingestion/status/${runId}`;

    // 3. Return the durable run immediately and dispatch to IngestionQueueService
    // for bounded concurrency and worker resilience.
    void this.queue.enqueue(runId, projectId, envelope);

    return {
      runId,
      statusUrl,
      acceptedAt: run?.startedAt
        ? run.startedAt.toISOString()
        : new Date().toISOString(),
      requestHash,
      status: (run?.status || IngestionStatus.RECEIVED) as any,
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
    projectId: string,
    runId: string,
  ): Promise<IngestionRunSnapshot> {
    const run = await this.repo.findRunById(projectId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }

    const log = (run.executionLog as any) || {};
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
    projectId: string,
    runId: string,
  ): Promise<{
    runId: string;
    projectId: string;
    status: string;
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
    const run = await this.repo.findRunById(projectId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }

    const log = (run.executionLog as any) || {};
    const total = Number(log.total) || 1;
    const processed =
      Number(log.processed) ||
      (run.status === IngestionStatus.READY ? total : 0);
    const succeeded =
      Number(log.succeeded) ||
      (run.status === IngestionStatus.READY && !log.duplicates ? 1 : 0);
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
        : run.status === IngestionStatus.READY
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
                status:
                  run.status === IngestionStatus.READY ? 'SUCCEEDED' : 'FAILED',
                itemId: run.itemId || undefined,
              },
            ]
          : [];

    return {
      runId: run.id,
      projectId,
      status: String(run.status),
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

  async retryRun(projectId: string, runId: string): Promise<any> {
    const run = await this.repo.findRunById(projectId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }

    await this.repo.updateRunStatus(projectId, runId, IngestionStatus.RECEIVED);

    const envelope = run.inputParams as unknown as IngestionSubmissionEnvelope;
    if (envelope && typeof envelope === 'object') {
      void this.queue.enqueue(runId, projectId, {
        ...envelope,
        projectId,
      });
      this.logger.log(
        `Retry initiated and re-enqueued for run ${runId} in project ${projectId}`,
      );
    } else {
      this.logger.warn(
        `Retry requested for run ${runId}, but inputParams is missing or invalid.`,
      );
    }

    return {
      runId,
      status: IngestionStatus.RECEIVED,
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

    const submissionRes = await this.submit(envelope);
    const runId = submissionRes.runId;

    if (submissionRes.deduplicated && submissionRes.existingItemId) {
      const item = this.catalogFacade
        ? await this.catalogFacade
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
      itemId && this.catalogFacade
        ? await this.catalogFacade
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
      errorMessage: (updatedRun as any)?.errorSummary?.lastError ?? undefined,
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
          `Unsupported ingestion source: ${(command as any).source}`,
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
