import { Injectable, Inject, Optional, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { IngestionStage, IngestionStatus, Prisma } from '@prisma/client';
import { IngestionRunAggregate, IngestionStageName } from '@/modules/library/ingestion/domain/ingestion-run.domain';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { IngestionSubmissionEnvelope, IngestionRunSnapshot, INGESTION_QUEUE_PORT, IIngestionQueuePort } from '@/modules/library/ingestion/types/ingestion.types';
import { isUUID } from 'class-validator';

interface ExecuteStepOptions<T> {
  compensate?: (result: T) => Promise<void>;
  outputSnapshot?: (result: T) => Prisma.InputJsonValue;
}

interface RegisteredCompensation {
  stageName: IngestionStageName;
  compensate: () => Promise<void>;
}

/**
 * IngestionSagaSession manages the forward execution and compensation stack
 * for a single execution of an ingestion pipeline run.
 */
export class IngestionSagaSession {
  private readonly compensationStack: RegisteredCompensation[] = [];
  private _isCompensating = false;

  constructor(
    public readonly runId: string,
    public readonly scopeId: string,
    public readonly aggregate: IngestionRunAggregate,
    private readonly repo: IngestionRepository,
    private readonly logger: Logger,
    public readonly isFinalAttempt: boolean = true,
  ) {}

  async executeStep<T>(
    stageName: IngestionStageName,
    action: () => Promise<T>,
    options?: ExecuteStepOptions<T>,
  ): Promise<T> {
    const startMs = Date.now();
    this.aggregate.startStep(stageName);

    try {
      const dbStage: IngestionStage =
        stageName === 'ENRICH_EXISTING'
          ? IngestionStage.ENRICH
          : stageName === 'RESOLVE'
            ? IngestionStage.RECONCILE
            : IngestionStage[stageName];
      await this.repo.updateRunStage(this.scopeId, this.runId, dbStage);
    } catch (stageUpdateErr: unknown) {
      const msg =
        stageUpdateErr instanceof Error
          ? stageUpdateErr.message
          : String(stageUpdateErr);
      this.logger.debug(
        `Best-effort stage status update skipped for run ${this.runId} (${stageName}): ${msg}`,
      );
    }

    try {
      const result = await action();
      const durationMs = Date.now() - startMs;
      this.aggregate.completeStep(stageName, durationMs);

      try {
        await this.repo.createStage(this.runId, {
          stageName,
          durationMs,
          success: true,
          outputSnapshot: options?.outputSnapshot
            ? options.outputSnapshot(result)
            : undefined,
        });
      } catch (stageErr: unknown) {
        const msg =
          stageErr instanceof Error ? stageErr.message : String(stageErr);
        this.logger.warn(
          `Failed to persist stage ${stageName} for run ${this.runId}: ${msg}`,
        );
      }

      if (options?.compensate) {
        this.compensationStack.push({
          stageName,
          compensate: async () => options.compensate!(result),
        });
      }

      return result;
    } catch (err: unknown) {
      const durationMs = Date.now() - startMs;
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.aggregate.failStep(stageName, errorMessage);

      try {
        await this.repo.createStage(this.runId, {
          stageName,
          durationMs,
          success: false,
          errorMessage,
        });
      } catch (recordErr: unknown) {
        const recordMsg =
          recordErr instanceof Error ? recordErr.message : String(recordErr);
        this.logger.warn(
          `Failed to record failed stage ${stageName} for run ${this.runId}: ${recordMsg}`,
        );
      }

      await this.rollback(stageName, errorMessage);
      throw err;
    }
  }

  async rollback(
    failedStage: IngestionStageName,
    reason: string,
  ): Promise<void> {
    if (this._isCompensating) return;
    this._isCompensating = true;

    this.logger.warn(
      `[SAGA_ROLLBACK] Initiating compensation for run ${this.runId} at stage ${failedStage}: ${reason}`,
    );

    this.aggregate.startCompensation(failedStage, reason);

    while (this.compensationStack.length > 0) {
      const comp = this.compensationStack.pop()!;
      try {
        this.logger.log(
          `[SAGA_COMPENSATE] Running compensation for step ${comp.stageName} on run ${this.runId}`,
        );
        await comp.compensate();
        this.aggregate.recordCompensatedStep(comp.stageName);
      } catch (compErr: unknown) {
        const compMsg =
          compErr instanceof Error ? compErr.message : String(compErr);
        this.logger.error(
          `[SAGA_COMPENSATE_ERROR] Failed compensation for step ${comp.stageName} on run ${this.runId}: ${compMsg}`,
        );
      }
    }

    this.aggregate.completeCompensation(!this.isFinalAttempt);

    try {
      await this.repo.updateRunStatus(
        this.scopeId,
        this.runId,
        this.isFinalAttempt
          ? IngestionStatus.FAILED_FINAL
          : IngestionStatus.FAILED_RETRYABLE,
        {
          lastError: `Saga rolled back after stage ${failedStage}: ${reason}`,
          ...(this.isFinalAttempt ? { completedAt: new Date() } : {}),
        },
      );
      markRunStatusTransitioned(this.runId);
    } catch (statusErr: unknown) {
      const statusMsg =
        statusErr instanceof Error ? statusErr.message : String(statusErr);
      this.logger.error(
        `Failed to update run status after rollback: ${statusMsg}`,
      );
    }
  }

  public get isCompensating(): boolean {
    return this._isCompensating;
  }

  public get pendingCompensationsCount(): number {
    return this.compensationStack.length;
  }
}

/**
 * IngestionSagaOrchestrator manages the lifecycle and execution sessions
 * of multi-stage ingestion sagas.
 */
@Injectable()
export class IngestionSagaOrchestrator {
  private readonly logger = new Logger(IngestionSagaOrchestrator.name);

  constructor(private readonly repo: IngestionRepository) {}

  createSession(
    runId: string,
    scopeId: string,
    aggregate: IngestionRunAggregate,
    options?: { isFinalAttempt?: boolean },
  ): IngestionSagaSession {
    return new IngestionSagaSession(
      runId,
      scopeId,
      aggregate,
      this.repo,
      this.logger,
      options?.isFinalAttempt ?? true,
    );
  }
}

export function resolveScope(
  scopeId: string,
  envelope: IngestionSubmissionEnvelope,
): { userId: string; projectId?: string } {
  const isProject =
    Boolean(scopeId) &&
    scopeId !== 'user' &&
    scopeId !== 'me' &&
    scopeId !== envelope.userId &&
    isUUID(scopeId);
  const userId = envelope.userId || (scopeId !== 'user' ? scopeId : 'system');
  const projectId = envelope.projectId || (isProject ? scopeId : undefined);
  return { userId, projectId };
}

export function getSubmissionPayloadLabel(
  payload: IngestionSubmissionEnvelope['payload'],
): string | undefined {
  if ('filename' in payload && payload.filename) return payload.filename;
  if ('url' in payload && payload.url) return payload.url;
  if ('value' in payload && payload.value) return payload.value;
  return undefined;
}

export function getSubmissionPayloadSize(
  payload: IngestionSubmissionEnvelope['payload'],
): number {
  return 'size' in payload && typeof payload.size === 'number'
    ? payload.size
    : 0;
}

const transitionedRunIds = new Set<string>();
const MAX_TRANSITIONED_RUN_CACHE = 1000;

export function clearRunStatusTransition(runId: string): void {
  if (!runId) return;
  transitionedRunIds.delete(runId);
}

export function markRunStatusTransitioned(runId: string): void {
  if (!runId) return;
  if (transitionedRunIds.size >= MAX_TRANSITIONED_RUN_CACHE) {
    const oldest = transitionedRunIds.values().next().value;
    if (oldest !== undefined) {
      transitionedRunIds.delete(oldest);
    }
  }
  transitionedRunIds.add(runId);
}

function consumeRunStatusTransition(runId: string): boolean {
  if (!runId || !transitionedRunIds.has(runId)) return false;
  transitionedRunIds.delete(runId);
  return true;
}

export async function transitionRunToFailedIfActive(params: {
  repo: IngestionRepository;
  scopeId: string;
  runId: string;
  status: IngestionStatus;
  lastError: string;
  completedAt?: Date;
  logger?: Logger;
}): Promise<boolean> {
  const { repo, scopeId, runId, status, lastError, completedAt, logger } =
    params;
  if (consumeRunStatusTransition(runId)) {
    return false;
  }
  const effectiveCompletedAt =
    completedAt ?? (status === IngestionStatus.FAILED_FINAL ? new Date() : undefined);
  await repo
    .updateRunStatus(scopeId, runId, status, {
      lastError,
      ...(effectiveCompletedAt ? { completedAt: effectiveCompletedAt } : {}),
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.error(
        `Failed to update run status to ${status} for run ${runId}: ${msg}`,
      );
    });
  return true;
}

export function createSingleItemExecutionLog(params: {
  sourceLabel: string;
  itemTitle: string;
  itemId?: string;
  status: 'SUCCEEDED' | 'DUPLICATE';
}): Prisma.InputJsonValue {
  const isDup = params.status === 'DUPLICATE';
  return {
    total: 1,
    processed: 1,
    succeeded: isDup ? 0 : 1,
    duplicates: isDup ? 1 : 0,
    failed: 0,
    percentage: 100,
    status: 'COMPLETED',
    currentTitle: params.itemTitle,
    items: [
      {
        title: params.sourceLabel,
        itemName: params.itemTitle,
        status: params.status,
        itemId: params.itemId,
      },
    ],
  };
}

interface IngestionExecutionLog {
  item?: { id?: string; title?: string };
  items?: Array<{
    itemId?: string;
    title?: string;
    itemName?: string;
    status?: string;
    error?: string;
  }>;
  status?: string;
  ingestionStatus?: string;
  message?: string;
  currentTitle?: string;
  total?: number;
  processed?: number;
  succeeded?: number;
  duplicates?: number;
  failed?: number;
  percentage?: number;
  [key: string]: unknown;
}

export interface IngestionRunProgressResult {
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
    itemName?: string;
    status: 'SUCCEEDED' | 'DUPLICATE' | 'FAILED' | 'BLOCKED';
    itemId?: string;
    error?: string;
  }>;
  startedAt: string;
  completedAt?: string;
}

@Injectable()
export class IngestionRunReporterService {
  private readonly logger = new Logger(IngestionRunReporterService.name);

  constructor(
    private readonly repo: IngestionRepository,
    @Optional()
    @Inject(INGESTION_QUEUE_PORT)
    private readonly queue?: IIngestionQueuePort,
  ) {}

  parseExecutionLog(executionLog: unknown): IngestionExecutionLog {
    if (
      executionLog &&
      typeof executionLog === 'object' &&
      !Array.isArray(executionLog)
    ) {
      return executionLog as IngestionExecutionLog;
    }
    return {};
  }

  async transitionRunToFailedIfActive(
    scopeId: string,
    runId: string,
    status: IngestionStatus,
    lastError: string,
    completedAt?: Date,
  ): Promise<boolean> {
    return transitionRunToFailedIfActive({
      repo: this.repo,
      scopeId,
      runId,
      status,
      lastError,
      completedAt,
      logger: this.logger,
    });
  }

  async getRunStatus(
    userIdOrScopeId: string,
    runId: string,
    projectId?: string,
  ): Promise<IngestionRunSnapshot> {
    const scope = projectId
      ? { userId: userIdOrScopeId, projectId }
      : userIdOrScopeId;
    const run = await this.repo.findRunById(scope, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }

    const log = this.parseExecutionLog(run.executionLog);
    const firstLogItem = Array.isArray(log.items) && log.items.length > 0 ? log.items[0] : null;
    const logItem =
      log.item ||
      (firstLogItem
        ? {
            id: firstLogItem.itemId || run.itemId,
            title: firstLogItem.itemName || firstLogItem.title,
          }
        : null);
    const runItem = run.item as
      { id?: string; title?: string } | null | undefined;
    const resolvedItem = runItem || logItem || null;
    const title =
      runItem?.title ||
      firstLogItem?.itemName ||
      log.currentTitle ||
      firstLogItem?.title ||
      log.item?.title ||
      null;
    const itemId =
      run.itemId ||
      resolvedItem?.id ||
      firstLogItem?.itemId ||
      null;

    const isBlocked =
      log.status === 'BLOCKED' ||
      log.ingestionStatus === 'BLOCKED';
    const effectiveLastError =
      run.lastError ||
      (typeof log.message === 'string' && isBlocked ? log.message : null) ||
      firstLogItem?.error ||
      null;

    return {
      ...run,
      ...(isBlocked
        ? {
            ingestionStatus: 'BLOCKED',
            resolutionStatus: 'BLOCKED',
          }
        : {}),
      ...(effectiveLastError
        ? {
            lastError: effectiveLastError,
            errorMessage: effectiveLastError,
          }
        : {}),
      itemId,
      item: resolvedItem
        ? { ...resolvedItem, title: resolvedItem.title || title }
        : null,
      title,
    } as unknown as IngestionRunSnapshot;
  }

  async getRunProgress(
    userIdOrScopeId: string,
    runId: string,
    projectId?: string,
  ): Promise<IngestionRunProgressResult> {
    const scope = projectId
      ? { userId: userIdOrScopeId, projectId }
      : userIdOrScopeId;
    const effectiveScopeId = projectId || userIdOrScopeId;
    const run = await this.repo.findRunById(scope, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }

    const log = this.parseExecutionLog(run.executionLog);
    const total = Number(log.total) || 1;
    const isBlocked =
      log.status === 'BLOCKED' ||
      log.ingestionStatus === 'BLOCKED';
    const isCompleted = run.status === IngestionStatus.COMPLETED;
    const processed = Number(log.processed) || (isCompleted ? total : 0);
    const succeeded =
      Number(log.succeeded) ||
      (isCompleted && !log.duplicates && !isBlocked ? 1 : 0);
    const duplicates = Number(log.duplicates) || 0;
    const failed =
      Number(log.failed) ||
      (run.status === IngestionStatus.FAILED_FINAL ||
      run.status === IngestionStatus.FAILED_RETRYABLE ||
      isBlocked
        ? 1
        : 0);
    const percentage =
      typeof log.percentage === 'number'
        ? log.percentage
        : isCompleted
          ? 100
          : Math.min(Math.round((processed / total) * 100), 99);

    const runItem = run.item as
      { id?: string; title?: string } | null | undefined;
    const firstLogItem = Array.isArray(log.items) && log.items.length > 0 ? log.items[0] : null;
    const title =
      runItem?.title ||
      firstLogItem?.itemName ||
      log.currentTitle ||
      firstLogItem?.title ||
      log.item?.title ||
      undefined;

    const items: Array<{
      title: string;
      itemName?: string;
      status: 'SUCCEEDED' | 'DUPLICATE' | 'FAILED' | 'BLOCKED';
      itemId?: string;
      error?: string;
    }> =
      Array.isArray(log.items) && log.items.length > 0
        ? log.items.map((it) => ({
            title: it.title || it.itemName || 'Untitled Document',
            ...(it.itemName ? { itemName: it.itemName } : {}),
            status:
              it.status === 'DUPLICATE' ||
              it.status === 'FAILED' ||
              it.status === 'BLOCKED'
                ? it.status
                : isBlocked
                  ? 'BLOCKED'
                  : 'SUCCEEDED',
            itemId: it.itemId,
            ...(it.error ? { error: it.error } : {}),
          }))
        : title
          ? [
              {
                title,
                status: isBlocked
                  ? 'BLOCKED'
                  : isCompleted
                    ? 'SUCCEEDED'
                    : 'FAILED',
                itemId: run.itemId || undefined,
                ...(run.lastError || (typeof log.message === 'string' ? log.message : undefined)
                  ? { error: run.lastError || (log.message as string) }
                  : {}),
              },
            ]
          : [];

    return {
      runId: run.id,
      projectId: effectiveScopeId,
      status: isBlocked ? 'BLOCKED' : String(run.status),
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
    userIdOrScopeId: string,
    runId: string,
    projectId?: string,
  ): Promise<{
    runId: string;
    status: IngestionStatus;
    message: string;
  }> {
    const scope = projectId
      ? { userId: userIdOrScopeId, projectId }
      : userIdOrScopeId;
    const effectiveScopeId = projectId || userIdOrScopeId;
    const run = await this.repo.findRunById(scope, runId);
    if (!run) {
      throw new NotFoundException(`Ingestion run '${runId}' not found`);
    }

    const retryableStatuses = [
      IngestionStatus.FAILED_RETRYABLE,
      IngestionStatus.FAILED_FINAL,
      IngestionStatus.STALLED,
    ];

    const transitioned = await this.repo.transitionRunStatusAtomic(
      runId,
      retryableStatuses,
      IngestionStatus.PENDING,
    );

    if (!transitioned) {
      const currentRun = await this.repo.findRunById(scope, runId);
      if (!currentRun) {
        throw new NotFoundException(`Ingestion run '${runId}' not found`);
      }
      if (
        currentRun.status === IngestionStatus.RUNNING ||
        currentRun.status === IngestionStatus.PENDING
      ) {
        throw new ConflictException(
          `Ingestion run '${runId}' is currently ${currentRun.status} and cannot be retried concurrently`,
        );
      }
      throw new BadRequestException(
        `Ingestion run '${runId}' with status '${String(currentRun.status)}' cannot be retried`,
      );
    }

    const resolvedProjectId =
      projectId && projectId !== 'user' && projectId !== userIdOrScopeId
        ? projectId
        : (run.projectId ?? undefined);
    const resolvedUserId = run.userId || userIdOrScopeId;
    const queueTargetScope =
      resolvedProjectId || resolvedUserId || effectiveScopeId;

    const envelope = run.inputParams as unknown as IngestionSubmissionEnvelope;
    let finalStatus: IngestionStatus = IngestionStatus.PENDING;
    if (envelope && typeof envelope === 'object' && this.queue) {
      try {
        await this.queue.enqueue(runId, queueTargetScope, {
          ...envelope,
          userId: resolvedUserId,
          projectId: resolvedProjectId,
        });
        this.logger.log(
          `Retry initiated and re-enqueued for run ${runId} (scope: ${queueTargetScope})`,
        );
      } catch (enqueueErr: unknown) {
        const errMsg =
          enqueueErr instanceof Error
            ? enqueueErr.message
            : String(enqueueErr);
        this.logger.error(
          `Failed to enqueue retried ingestion run ${runId}: ${errMsg}`,
        );
        finalStatus = IngestionStatus.FAILED_RETRYABLE;
        await this.repo
          .updateRunStatus(scope, runId, IngestionStatus.FAILED_RETRYABLE, {
            lastError: `Failed to enqueue retry run: ${errMsg}`,
          })
          .catch((repoErr: unknown) => {
            this.logger.error(
              `Failed to revert run ${runId} to FAILED_RETRYABLE after queue failure: ${repoErr instanceof Error ? repoErr.message : String(repoErr)}`,
            );
          });
      }
    } else {
      this.logger.warn(
        `Retry requested for run ${runId}, but inputParams is missing or invalid.`,
      );
    }

    return {
      runId,
      status: finalStatus,
      message:
        finalStatus === IngestionStatus.PENDING
          ? 'Ingestion run retry initiated and enqueued'
          : 'Ingestion run retry enqueue failed; marked as FAILED_RETRYABLE',
    };
  }
}
