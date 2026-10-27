/**
 * modules/manuscripts/core/utils/saga-runner.ts
 *
 * Lightweight Saga / Compensation Pattern runner for multi-step cross-module operations
 * (e.g. Docstore + Filestore + Structure + Git Bridge) that span resources outside a
 * single database transaction.
 *
 * Steps execute sequentially; if any step throws, previously completed steps are
 * compensated in reverse (LIFO) order.
 */

export interface CompensableStep<TResult = void> {
  readonly name: string;
  execute(): Promise<TResult>;
  compensate?(result: TResult): Promise<void> | void;
}

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
  private readonly steps: Array<CompensableStep<any>> = [];
  private readonly completedDynamicSteps: Array<{
    name: string;
    compensate?: (result: any) => Promise<void> | void;
    result: any;
  }> = [];

  constructor(private readonly runnerOptions?: SagaRunnerOptions) {}

  public addStep<TResult>(step: CompensableStep<TResult>): this {
    this.steps.push(step);
    return this;
  }

  /**
   * Imperative Saga step execution: runs `execute()` immediately and records `compensate(result)`
   * so `compensateAll()` can roll back in reverse (LIFO) order if a subsequent step fails.
   */
  public async step<TResult>(
    name: string,
    execute: () => Promise<TResult>,
    compensate?: (result: TResult) => Promise<void> | void,
  ): Promise<TResult> {
    const result = await execute();
    this.completedDynamicSteps.push({ name, compensate, result });
    return result;
  }

  public async compensateAll(options?: SagaExecutionOptions): Promise<void> {
    for (let i = this.completedDynamicSteps.length - 1; i >= 0; i--) {
      const { name, compensate, result } = this.completedDynamicSteps[i];
      if (!compensate) continue;
      try {
        await compensate(result);
      } catch (compErr) {
        options?.onCompensationError?.(name, compErr);
        this.runnerOptions?.logger?.warn?.(
          `[Saga:${this.runnerOptions?.contextName ?? 'default'}] Compensation failed for ${name}: ${String(compErr)}`,
        );
      }
    }
    this.completedDynamicSteps.length = 0;
  }

  public async run(options?: SagaExecutionOptions): Promise<void> {
    const completed: Array<{ step: CompensableStep<any>; result: any }> = [];

    try {
      for (const step of this.steps) {
        const result = await step.execute();
        completed.push({ step, result });
      }
    } catch (err) {
      for (let i = completed.length - 1; i >= 0; i--) {
        const { step, result } = completed[i];
        if (!step.compensate) continue;
        try {
          await step.compensate(result);
        } catch (compErr) {
          options?.onCompensationError?.(step.name, compErr);
        }
      }
      throw err;
    }
  }
}
