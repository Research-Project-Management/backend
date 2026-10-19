import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { QueueService } from './queue.service';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/submission.types';
import { IngestionRunSnapshot } from '@/modules/library/ingestion/types/ingestion.types';
import { IngestionStatus } from '@prisma/client';

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

    await this.repo.updateRunStatus(scope, runId, IngestionStatus.PENDING);

    const envelope = run.inputParams as unknown as IngestionSubmissionEnvelope;
    if (envelope && typeof envelope === 'object') {
      void this.queue.enqueue(runId, effectiveScopeId, {
        ...envelope,
        ...(projectId
          ? { userId: userIdOrScopeId, projectId }
          : { projectId: effectiveScopeId }),
      });
      this.logger.log(
        `Retry initiated and re-enqueued for run ${runId} (scope: ${effectiveScopeId})`,
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
