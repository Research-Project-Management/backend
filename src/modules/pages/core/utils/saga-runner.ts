/**
 * modules/pages/core/utils/saga-runner.ts
 *
 * Lightweight imperative Saga / Compensation Pattern runner for multi-step cross-module
 * operations (e.g. Docstore + Filestore + Structure + Git Bridge) that span resources
 * outside a single database transaction.
 *
 * Steps execute imperatively via `step()`; if any subsequent step throws,
 * `compensateAll()` rolls back completed steps in reverse (LIFO) order.
 */

export interface SagaExecutionOptions {
  onCompensationError?: (stepName: string, error: unknown) => void;
}

export interface SagaRunnerOptions {
  logger?: {
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  contextName?: string;
}

export class SagaRunner {
  private readonly completedSteps: Array<{
    name: string;
    compensate?: () => Promise<void> | void;
  }> = [];

  constructor(private readonly runnerOptions?: SagaRunnerOptions) {}

  /**
   * Executes `execute()` immediately and records `compensate(result)` so
   * `compensateAll()` can roll back in reverse (LIFO) order if a subsequent step fails.
   */
  public async step<TResult>(
    name: string,
    execute: () => Promise<TResult>,
    compensate?: (result: TResult) => Promise<void> | void,
  ): Promise<TResult> {
    const result = await execute();
    this.completedSteps.push({
      name,
      compensate: compensate ? () => compensate(result) : undefined,
    });
    return result;
  }

  public async compensateAll(options?: SagaExecutionOptions): Promise<void> {
    for (let i = this.completedSteps.length - 1; i >= 0; i--) {
      const { name, compensate } = this.completedSteps[i];
      if (!compensate) continue;
      try {
        await compensate();
      } catch (compErr) {
        options?.onCompensationError?.(name, compErr);
        this.runnerOptions?.logger?.warn?.(
          `[Saga:${this.runnerOptions?.contextName ?? 'default'}] Compensation failed for ${name}: ${String(compErr)}`,
        );
      }
    }
    this.completedSteps.length = 0;
  }
}
