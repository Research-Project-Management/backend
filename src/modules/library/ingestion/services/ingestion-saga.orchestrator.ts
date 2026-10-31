import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Job } from 'bullmq';
import { IngestionStage, IngestionStatus, Prisma } from '@prisma/client';
import {
  IngestionRunAggregate,
  IngestionStageName,
} from '@/modules/library/ingestion/domain/ingestion-run.aggregate';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import {
  LIBRARY_INGESTION_QUEUE_STANDARD,
  LIBRARY_INGESTION_JOB,
} from '@/modules/library/ingestion/types/ingestion.types';
import { isNonRetryableIngestionError } from '@/modules/library/ingestion/types/ingestion.errors';
import { QueuedIngestionJob } from './queue.service';
import { PipelineService } from './pipeline.service';

export interface ExecuteStepOptions<T> {
  compensate?: (result: T) => Promise<void>;
  outputSnapshot?: (result: T) => Prisma.InputJsonValue;
}

export interface RegisteredCompensation {
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

    this.aggregate.completeCompensation();

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

@Processor(LIBRARY_INGESTION_QUEUE_STANDARD, { concurrency: 4 })
export class IngestionQueueConsumer
  extends WorkerHost
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(IngestionQueueConsumer.name);

  constructor(
    private readonly pipeline: PipelineService,
    private readonly repo: IngestionRepository,
  ) {
    super();
  }

  onApplicationBootstrap() {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(`Ingestion Worker connection notice: ${err.message}`);
      });
      this.logger.log(
        `IngestionQueueConsumer registered with BullMQ on queue: ${LIBRARY_INGESTION_QUEUE_STANDARD} (concurrency: 4)`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `IngestionQueueConsumer worker listener skipped: ${msg}`,
      );
    }
  }

  async onApplicationShutdown() {
    try {
      if (this.worker) {
        this.logger.log(`Closing IngestionQueueConsumer worker on shutdown...`);
        await this.worker.close();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Error closing IngestionQueueConsumer worker: ${msg}`);
    }
  }

  async process(job: Job<QueuedIngestionJob>): Promise<void> {
    if (job.name !== LIBRARY_INGESTION_JOB && job.name !== '__default__') {
      this.logger.debug(`Ignoring unknown job name: ${job.name}`);
      return;
    }

    const { runId, projectId, envelope } = job.data;
    const startTime = Date.now();
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    this.logger.log(
      `[BULLMQ_START] Processing ingestion job ${job.id} (run: ${runId}) for project ${projectId} (attempt: ${job.attemptsMade + 1}/${job.opts.attempts || 1})`,
    );

    try {
      await this.repo
        .updateRunStatus(projectId, runId, IngestionStatus.RUNNING)
        .catch((statusErr: unknown) => {
          const statusMsg =
            statusErr instanceof Error ? statusErr.message : String(statusErr);
          this.logger.warn(
            `Failed to set RUNNING status for run ${runId}: ${statusMsg}`,
          );
        });

      await this.pipeline.executePipeline(
        runId,
        projectId,
        { ...envelope, isFinalAttempt },
        { isFinalAttempt },
      );

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(
        `[BULLMQ_DONE] Ingestion run ${runId} completed successfully in ${elapsed}s`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const isTerminalFailure =
        isFinalAttempt || isNonRetryableIngestionError(err);

      this.logger.error(
        `[BULLMQ_ERROR] Ingestion run ${runId} failed after ${elapsed}s (isLast: ${isTerminalFailure}): ${msg}`,
      );

      const alreadyTransitioned = Boolean(
        (err as { __runStatusTransitioned?: boolean } | null | undefined)
          ?.__runStatusTransitioned,
      );

      if (!alreadyTransitioned) {
        await this.repo
          .updateRunStatus(
            projectId,
            runId,
            isTerminalFailure
              ? IngestionStatus.FAILED_FINAL
              : IngestionStatus.FAILED_RETRYABLE,
            {
              lastError:
                msg ||
                (isTerminalFailure
                  ? 'Ingestion pipeline execution failed permanently'
                  : 'Ingestion pipeline execution failed (retryable)'),
            },
          )
          .catch((updateErr: unknown) => {
            const updateMsg =
              updateErr instanceof Error
                ? updateErr.message
                : String(updateErr);
            this.logger.error(
              `Failed to update run status for failed run ${runId}: ${updateMsg}`,
            );
          });
      }

      throw err;
    }
  }
}
