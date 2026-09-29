/**
 * modules/manuscripts/clsi/core/ports/runner.port.ts
 * Contract for process & sandbox runners (Local child_process, Docker container)
 */

export interface ProcessExecutionOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  onLogChunk?: (chunk: string) => void;
}

export interface ProcessExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ISandboxRunner {
  readonly name: string;
  run(
    command: string,
    args: string[],
    options: ProcessExecutionOptions,
  ): Promise<ProcessExecutionResult>;
}
