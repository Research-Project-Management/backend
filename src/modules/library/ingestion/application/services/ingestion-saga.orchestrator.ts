import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { IngestionRunAggregate } from '../../domain/model/ingestion-run.aggregate';
import { IngestionStageName } from '../../domain/events/ingestion-domain.event';
import { IngestionRepository } from '../../infrastructure/repositories/ingestion.repository';
import {
  CATALOG_FACADE,
  ICatalogFacade,
} from '../../../bibliography/bibliography.facade';
import { IngestionStatus, Prisma } from '@prisma/client';

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
      const dbStage = (stageName === 'ENRICH_EXISTING' ? 'ENRICH' : stageName) as any;
      await this.repo.updateRunStage(this.scopeId, this.runId, dbStage).catch(() => {});
    } catch {
      // Ignored: Best effort status update
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
      } catch (stageErr: any) {
        this.logger.warn(
          `Failed to persist stage ${stageName} for run ${this.runId}: ${stageErr?.message}`,
        );
      }

      if (options?.compensate) {
        this.compensationStack.push({
          stageName,
          compensate: async () => options.compensate!(result),
        });
      }

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      const errorMessage = err?.message || String(err);
      this.aggregate.failStep(stageName, errorMessage);

      try {
        await this.repo.createStage(this.runId, {
          stageName,
          durationMs,
          success: false,
          errorMessage,
        });
      } catch (recordErr: any) {
        this.logger.warn(
          `Failed to record failed stage ${stageName} for run ${this.runId}: ${recordErr?.message}`,
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
      } catch (compErr: any) {
        this.logger.error(
          `[SAGA_COMPENSATE_ERROR] Failed compensation for step ${comp.stageName} on run ${this.runId}: ${compErr?.message || compErr}`,
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
    } catch (statusErr: any) {
      this.logger.error(
        `Failed to update run status after rollback: ${statusErr?.message}`,
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

  constructor(
    private readonly repo: IngestionRepository,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogFacade?: ICatalogFacade,
  ) {}

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
