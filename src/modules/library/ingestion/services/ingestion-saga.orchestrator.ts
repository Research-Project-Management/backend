import { Injectable, Logger } from '@nestjs/common';
import {
  IngestionRunAggregate,
  IngestionStageName,
} from '@/modules/library/ingestion/domain/ingestion-run.aggregate';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { IngestionStage, IngestionStatus, Prisma } from '@prisma/client';

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
  ) {}

  /**
   * Executes a single forward pipeline step within the Saga boundary.
   * If the step succeeds, its completion is tracked and its optional compensation handler
   * is pushed onto the LIFO compensation stack.
   * If the step fails, the failure is recorded and the compensation stack is executed in reverse.
   */
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

  /**
   * Triggers backward compensation for all completed steps in reverse order (LIFO).
   */
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
        IngestionStatus.FAILED_FINAL,
        {
          lastError: `Saga rolled back after stage ${failedStage}: ${reason}`,
          completedAt: new Date(),
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

  /**
   * Creates a new isolated Saga execution session for a pipeline run.
   */
  createSession(
    runId: string,
    scopeId: string,
    aggregate: IngestionRunAggregate,
  ): IngestionSagaSession {
    return new IngestionSagaSession(
      runId,
      scopeId,
      aggregate,
      this.repo,
      this.logger,
    );
  }
}
