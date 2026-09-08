import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveTenantWorkspaceId } from '../../../core/utils/tenant.util';
import {
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
  SubmissionPayload,
} from './types/ingestion-submission.types';
import {
  IngestionCommand,
  IngestionResult,
  IngestionPort,
  IngestionRunSnapshot,
} from './types/ingestion.types';
import { IngestionRepository } from './ingestion.repository';
import { IngestionStatus, Prisma } from '@prisma/client';
import { IngestionPipelineRunner } from './services/ingestion-pipeline.runner';
import { UrlCaptureService } from './services/url-capture.service';
import { ItemsService } from '../items/items.service';
import { createHash, randomUUID } from 'crypto';

@Injectable()
export class IngestionService implements IngestionPort {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestionRepo: IngestionRepository,
    private readonly runner: IngestionPipelineRunner,
    private readonly urlCapture: UrlCaptureService,
    private readonly itemsService: ItemsService,
  ) {}

  /**
   * Primary Fast-Path Submission Entry Point (Async 202 Contract)
   */
  async submit(
    envelope: IngestionSubmissionEnvelope,
  ): Promise<IngestionAcceptedResult> {
    const workspaceId = await this.resolveWorkspaceId(envelope.workspaceId);
    const idempotencyKey = envelope.idempotencyKey?.trim();

    const requestHash = createHash('sha256')
      .update(JSON.stringify({ workspaceId, payload: envelope.payload }))
      .digest('hex');

    // 1. Idempotency Check & Atomic Claim
    if (idempotencyKey) {
      const existingRun = await this.ingestionRepo.findRunByIdempotencyKey(
        workspaceId,
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
          statusUrl: `/api/v1/workspaces/${workspaceId}/library/ingestion/status/${existingRun.id}`,
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
    const run = await this.ingestionRepo.createRun(workspaceId, {
      requesterId: envelope.userId,
      inputParams: envelope as unknown as Prisma.InputJsonValue,
      inputHash: requestHash,
      idempotencyKey,
      contractVersion: envelope.contractVersion || '1.0.0',
    });

    const runId = run?.id || randomUUID();
    const statusUrl = `/api/v1/workspaces/${workspaceId}/library/ingestion/status/${runId}`;

    // 3. Return the durable run immediately. Provider resolution and PDF
    // extraction can exceed an HTTP request budget, so they must never hold
    // the caller open after the run is persisted.
    void this.executePipeline(runId, workspaceId, envelope).catch(
      async (err: any) => {
        this.logger.error(
          `Ingestion pipeline failed for run ${runId}: ${err?.message || err}`,
        );
        await this.ingestionRepo.updateRunStatus(
          workspaceId,
          runId,
          IngestionStatus.FAILED_FINAL,
          { lastError: err?.message || 'Unknown ingestion pipeline failure' },
        );
      },
    );

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
   * Delegated to IngestionPipelineRunner.
   */
  async executePipeline(
    runId: string,
    workspaceId: string,
    envelope: IngestionSubmissionEnvelope,
  ): Promise<void> {
    return this.runner.executePipeline(runId, workspaceId, envelope);
  }

  async getRunStatus(
    workspaceId: string,
    runId: string,
  ): Promise<IngestionRunSnapshot> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const run = await this.ingestionRepo.findRunById(canonicalWorkspaceId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }
    return run as unknown as IngestionRunSnapshot;
  }

  async retryRun(workspaceId: string, runId: string): Promise<any> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const run = await this.ingestionRepo.findRunById(canonicalWorkspaceId, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }
    await this.ingestionRepo.updateRunStatus(
      canonicalWorkspaceId,
      runId,
      IngestionStatus.RECEIVED,
    );
    return {
      runId,
      status: IngestionStatus.RECEIVED,
      message: 'Ingestion run retry initiated',
    };
  }

  /**
   * Unified synchronous/direct ingestion entry point.
   * Delegates to modern IngestionPipelineRunner via mapped envelope.
   */
  async ingest(command: IngestionCommand): Promise<IngestionResult> {
    const workspaceId = await this.resolveWorkspaceId(command.workspaceId);
    const envelope = this.mapCommandToEnvelope(workspaceId, command);

    const submissionRes = await this.submit(envelope);
    const runId = submissionRes.runId;

    if (submissionRes.deduplicated && submissionRes.existingItemId) {
      const item = this.itemsService
        ? await this.itemsService
            .getItem(workspaceId, submissionRes.existingItemId)
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
      await this.runner.executePipeline(runId, workspaceId, envelope);
    } catch (err: any) {
      this.logger.error(
        `Ingestion pipeline failed for run ${runId}: ${err?.message || err}`,
      );
      await this.ingestionRepo
        .updateRunStatus(workspaceId, runId, IngestionStatus.FAILED_FINAL, {
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

    const updatedRun = await this.ingestionRepo.findRunById(workspaceId, runId);
    const itemId = updatedRun?.itemId ?? undefined;
    const item =
      itemId && this.itemsService
        ? await this.itemsService
            .getItem(workspaceId, itemId)
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
      errorMessage: ((updatedRun as any)?.errorSummary as any)?.lastError ?? undefined,
    };
  }

  private mapCommandToEnvelope(
    workspaceId: string,
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
      workspaceId,
      userId: command.userId,
      idempotencyKey: command.idempotencyKey,
      payload,
      collectionIds: command.collectionId ? [command.collectionId] : undefined,
      overrides:
        'overrides' in command
          ? (command.overrides as Record<string, unknown>)
          : undefined,
    };
  }

  // ── Backward Compatibility Convenience Methods ────────────────────────────

  async ingestDoi(workspaceId: string, userId: string, dto: any) {
    const res = await this.ingest({
      source: 'doi',
      workspaceId,
      userId,
      doi: dto.doi,
      collectionId: dto.collectionId,
      idempotencyKey: dto.idempotencyKey,
    });
    return res.item || { id: res.itemId, runId: res.runId };
  }

  async ingestBibtex(workspaceId: string, userId: string, dto: any) {
    const res = await this.ingest({
      source: 'bibtex',
      workspaceId,
      userId,
      content: dto.bibtex || dto.content,
      collectionId: dto.collectionId,
      idempotencyKey: dto.idempotencyKey,
    });
    return res.item || { id: res.itemId, runId: res.runId };
  }

  async startRun(workspaceId: string, userId: string, dto: any) {
    const res = await this.ingest({
      source: dto.source || 'doi',
      workspaceId,
      userId,
      doi: dto.doi || '',
      content: dto.content || '',
      idempotencyKey: dto.idempotencyKey,
    });
    return { runId: res.runId, status: res.status };
  }

  async captureUrl(
    url: string,
    contextOrWorkspaceId: string | { workspaceId: string; userId?: string },
  ) {
    return this.urlCapture.captureUrl(url, contextOrWorkspaceId);
  }

  async confirmCapturedUrl(workspaceId: string, userId: string, dto: any) {
    return this.urlCapture.confirmCapturedUrl(workspaceId, userId, dto);
  }

  async cleanupExpiredPreviews(retentionDays = 7): Promise<number> {
    return this.urlCapture.cleanupExpiredPreviews(retentionDays);
  }

  private resolveWorkspaceId(workspaceId: string): Promise<string> {
    return resolveTenantWorkspaceId(this.prisma, workspaceId);
  }
}
