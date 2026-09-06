import {
  Injectable,
  Logger,
  Inject,
  Optional,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveTenantWorkspaceId } from '../../../core/utils/tenant.util';
import {
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
} from './types/ingestion-submission.types';
import {
  IngestionCommand,
  IngestionResult,
  IngestionPort,
  IngestionRunSnapshot,
} from './types/ingestion.types';
import { IngestionIdempotencyConflictException } from './errors/ingestion.errors';
import { IngestionRepository } from './ingestion.repository';
import { IdentifyStage } from './stages/identify.stage';
import { NormalizeStage } from './stages/normalize.stage';
import { EnrichStage } from './stages/enrich.stage';
import { ReconcileStage } from './stages/reconcile.stage';
import { MatchStage } from './stages/match.stage';
import { CommitStage } from './stages/commit.stage';
import { TransactionService } from '../outbox/transaction.service';
import { METADATA_PORT, MetadataPort } from './metadata/types/metadata.types';
import { STORAGE_PORT, IStoragePort } from '../../storage/storage.port';
import { UrlCaptureProvider } from './providers/url-capture.provider';
import { PdfExtractorProvider } from '../attachments/providers/pdf-extractor.provider';
import { CatalogService } from '../items/items.service';
import { NotesService } from '../notes/notes.service';
import { IdempotencyRepository } from '../sync/repositories/idempotency.repository';
import { IngestionStatus, Prisma } from '@prisma/client';
import { IngestionStrategyRegistry } from './strategies/ingestion-strategy.registry';
import { IngestionExecutionContext } from './strategies/ingestion-strategy.interface';
import { IngestionPipelineRunner } from './services/ingestion-pipeline.runner';
import { UrlCaptureService } from './services/url-capture.service';
import { createHash, randomUUID } from 'crypto';

@Injectable()
export class IngestionService implements IngestionPort {
  private readonly logger = new Logger(IngestionService.name);
  private readonly runner: IngestionPipelineRunner;
  private readonly urlCapture: UrlCaptureService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestionRepo: IngestionRepository,
    @Optional() private readonly identifyStage?: IdentifyStage,
    @Optional() private readonly normalizeStage?: NormalizeStage,
    @Optional() private readonly enrichStage?: EnrichStage,
    @Optional() private readonly reconcileStage?: ReconcileStage,
    @Optional() private readonly matchStage?: MatchStage,
    @Optional() private readonly commitStage?: CommitStage,
    @Optional() private readonly strategyRegistry?: IngestionStrategyRegistry,
    @Optional() private readonly txService?: TransactionService,
    @Optional() private readonly catalogService?: CatalogService,
    @Optional()
    @Inject(METADATA_PORT)
    private readonly metadataPort?: MetadataPort,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional() private readonly urlCaptureProvider?: UrlCaptureProvider,
    @Optional() private readonly pdfExtractor?: PdfExtractorProvider,
    @Optional() private readonly notesService?: NotesService,
    @Optional() private readonly idempotencyRepo?: IdempotencyRepository,
    @Optional() private readonly pipelineRunner?: IngestionPipelineRunner,
    @Optional() private readonly urlCaptureService?: UrlCaptureService,
  ) {
    this.runner =
      this.pipelineRunner ??
      new IngestionPipelineRunner(
        this.ingestionRepo,
        this.identifyStage,
        this.normalizeStage,
        this.enrichStage,
        this.reconcileStage,
        this.matchStage,
        this.commitStage,
        this.catalogService,
        this.notesService,
      );

    this.urlCapture =
      this.urlCaptureService ??
      new UrlCaptureService(
        this.prisma,
        this.urlCaptureProvider,
        this.txService,
        this.catalogService,
      );
  }

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
   * Delegates to specialized strategy via IngestionStrategyRegistry.
   */
  async ingest(command: IngestionCommand): Promise<IngestionResult> {
    const workspaceId = await this.resolveWorkspaceId(command.workspaceId);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          workspaceId,
          source: command.source,
          payload: command,
        }),
      )
      .digest('hex');

    // 1. Idempotency Check & Atomic Claim
    let leaseToken: string | undefined;
    if (command.idempotencyKey && this.idempotencyRepo?.claim) {
      const claimRes = await this.idempotencyRepo.claim(
        workspaceId,
        command.idempotencyKey,
        requestHash,
      );

      if (claimRes.status === 'cached' && claimRes.record?.responseBody) {
        return claimRes.record.responseBody as unknown as IngestionResult;
      }

      if (claimRes.status === 'mismatch') {
        throw new IngestionIdempotencyConflictException(
          `Idempotency key "${command.idempotencyKey}" was already used with a different request payload`,
        );
      }

      if (claimRes.status === 'acquired') {
        leaseToken = claimRes.leaseToken;
      }
    }

    const run = await this.ingestionRepo
      .createRun(workspaceId, {
        requesterId: command.userId || 'system',
        inputParams: command as unknown as Prisma.InputJsonValue,
        inputHash: requestHash,
        idempotencyKey: command.idempotencyKey,
      })
      .catch((err) => {
        this.logger.warn(
          `Failed to create ingestion run record: ${err?.message}`,
        );
        return null;
      });

    const runId = run?.id || randomUUID();

    const context: IngestionExecutionContext = {
      workspaceId,
      runId,
      requestHash,
      saveIdempotency: (workspaceId, key, hash, result) =>
        this.saveIdempotency(workspaceId, key, hash, result, leaseToken),
      updateRunStatus: async (workspaceId, runId, status, meta) => {
        await this.ingestionRepo
          .updateRunStatus(workspaceId, runId, status, meta)
          .catch((err) => {
            this.logger.warn(`Failed to update run status: ${err?.message}`);
          });
      },
      withKeyLock: <T>(key: string, fn: () => Promise<T>) =>
        this.withKeyLock(key, fn),
    };

    if (!this.strategyRegistry) {
      throw new Error('IngestionStrategyRegistry is not configured');
    }

    const strategy = this.strategyRegistry.getStrategy(command.source);
    return await strategy.execute(command, context);
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

  private async saveIdempotency(
    workspaceId: string,
    idempotencyKey: string | undefined,
    requestHash: string,
    result: IngestionResult,
    leaseToken?: string,
  ): Promise<void> {
    const idempotencyRepo = this.idempotencyRepo;
    if (!idempotencyKey || !idempotencyRepo) return;

    try {
      if (
        this.txService?.executeInTransaction &&
        typeof idempotencyRepo.markSucceededInTx === 'function'
      ) {
        await this.txService.executeInTransaction(
          async (tx: Prisma.TransactionClient) => {
            await idempotencyRepo.markSucceededInTx(
              tx,
              workspaceId,
              idempotencyKey,
              200,
              result,
              leaseToken,
            );
          },
        );
      } else if (typeof idempotencyRepo.markSucceeded === 'function') {
        await idempotencyRepo.markSucceeded(
          workspaceId,
          idempotencyKey,
          200,
          result,
          leaseToken,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Failed to persist idempotency key "${idempotencyKey}": ${err?.message}`,
      );
    }
  }

  private readonly locks = new Map<string, Promise<any>>();

  private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const currentLock = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, nextLock);

    await currentLock.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === nextLock) {
        this.locks.delete(key);
      }
    }
  }

  private resolveWorkspaceId(workspaceId: string): Promise<string> {
    return resolveTenantWorkspaceId(this.prisma, workspaceId);
  }
}
