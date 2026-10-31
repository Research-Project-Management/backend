import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { QueueService } from './queue.service';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/ingestion.types';
import { IngestionRunSnapshot } from '@/modules/library/ingestion/types/ingestion.types';
import { IngestionStatus, Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';

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

export function consumeRunStatusTransition(runId: string): boolean {
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
  await repo
    .updateRunStatus(scopeId, runId, status, {
      lastError,
      ...(completedAt ? { completedAt } : {}),
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

export interface IngestionExecutionLog {
  item?: { id?: string; title?: string };
  items?: Array<{ itemId?: string; title?: string; status?: string }>;
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
    status: 'SUCCEEDED' | 'DUPLICATE' | 'FAILED';
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
    @Inject(forwardRef(() => QueueService))
    private readonly queue: QueueService,
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
    const logItem =
      log.item ||
      (Array.isArray(log.items) && log.items.length > 0
        ? { id: log.items[0].itemId || run.itemId, title: log.items[0].title }
        : null);
    const runItem = run.item as
      { id?: string; title?: string } | null | undefined;
    const resolvedItem = runItem || logItem || null;
    const title =
      runItem?.title ||
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

    const runItem = run.item as
      { id?: string; title?: string } | null | undefined;
    const title =
      runItem?.title ||
      log.currentTitle ||
      (Array.isArray(log.items) && log.items[0]?.title) ||
      log.item?.title ||
      undefined;

    const items: Array<{
      title: string;
      status: 'SUCCEEDED' | 'DUPLICATE' | 'FAILED';
      itemId?: string;
      error?: string;
    }> =
      Array.isArray(log.items) && log.items.length > 0
        ? log.items.map((it) => ({
            title: it.title || 'Untitled Document',
            status:
              it.status === 'DUPLICATE' || it.status === 'FAILED'
                ? it.status
                : 'SUCCEEDED',
            itemId: it.itemId,
          }))
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
      projectId: effectiveScopeId,
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

    const retryableStatuses = new Set<string>([
      IngestionStatus.FAILED_RETRYABLE,
      IngestionStatus.FAILED_FINAL,
      IngestionStatus.STALLED,
    ]);
    if (!retryableStatuses.has(String(run.status))) {
      if (run.status === IngestionStatus.RUNNING) {
        throw new ConflictException(
          `Ingestion run '${runId}' is currently RUNNING and cannot be retried`,
        );
      }
      throw new BadRequestException(
        `Ingestion run '${runId}' with status '${String(run.status)}' cannot be retried`,
      );
    }

    await this.repo.updateRunStatus(scope, runId, IngestionStatus.PENDING, {
      previousStatus: run.status,
    });

    const resolvedProjectId =
      projectId && projectId !== 'user' && projectId !== userIdOrScopeId
        ? projectId
        : (run.projectId ?? undefined);
    const resolvedUserId = run.userId || userIdOrScopeId;
    const queueTargetScope =
      resolvedProjectId || resolvedUserId || effectiveScopeId;

    const envelope = run.inputParams as unknown as IngestionSubmissionEnvelope;
    if (envelope && typeof envelope === 'object') {
      void this.queue
        .enqueue(runId, queueTargetScope, {
          ...envelope,
          userId: resolvedUserId,
          projectId: resolvedProjectId,
        })
        .catch(async (enqueueErr: unknown) => {
          const errMsg =
            enqueueErr instanceof Error
              ? enqueueErr.message
              : String(enqueueErr);
          this.logger.error(
            `Failed to enqueue retried ingestion run ${runId}: ${errMsg}`,
          );
          await this.repo
            .updateRunStatus(scope, runId, IngestionStatus.FAILED_RETRYABLE, {
              lastError: `Failed to enqueue retry run: ${errMsg}`,
            })
            .catch((repoErr: unknown) => {
              this.logger.error(
                `Failed to revert run ${runId} to FAILED_RETRYABLE after queue failure: ${repoErr instanceof Error ? repoErr.message : String(repoErr)}`,
              );
            });
        });
      this.logger.log(
        `Retry initiated and re-enqueued for run ${runId} (scope: ${queueTargetScope})`,
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
}
