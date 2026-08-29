import { Injectable, Logger } from '@nestjs/common';
import { SandboxResult, SandboxTask, SandboxRunnerPort } from './sandbox.types';

@Injectable()
export class LocalSandboxRunnerService implements SandboxRunnerPort {
  private readonly logger = new Logger(LocalSandboxRunnerService.name);

  async run<TInput = unknown, TOutput = unknown>(
    task: SandboxTask<TInput>,
  ): Promise<SandboxResult<TOutput>> {
    const startTime = Date.now();
    const timeoutMs = task.timeoutMs || 30_000;

    try {
      // Execute the task with timeout protection
      const executionPromise = this.executeTaskLocally<TInput, TOutput>(task);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `Sandbox task ${task.id} timed out after ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      });

      const output = await Promise.race([executionPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      return {
        taskId: task.id,
        success: true,
        data: output,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      this.logger.warn(
        `Local sandbox task ${task.id} (${task.taskType}) failed: ${err.message}`,
      );
      return {
        taskId: task.id,
        success: false,
        error: err.message || 'Sandbox execution error',
        durationMs,
      };
    }
  }

  private async executeTaskLocally<TInput, TOutput>(
    task: SandboxTask<TInput>,
  ): Promise<TOutput> {
    // If input is an executable function/handler
    if (typeof (task.input as any)?.run === 'function') {
      return await (task.input as any).run();
    }
    // Default pass-through wrapper
    return task.input as unknown as TOutput;
  }
}
