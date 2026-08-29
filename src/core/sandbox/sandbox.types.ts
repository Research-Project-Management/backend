export interface SandboxTask<TInput = unknown> {
  id: string;
  taskType:
    | 'pdf_extract'
    | 'metadata_extract'
    | 'ocr'
    | 'crawler_parse'
    | 'unsafe_compute';
  input: TInput;
  timeoutMs?: number;
  memoryLimitMb?: number;
}

export interface SandboxResult<TOutput = unknown> {
  taskId: string;
  success: boolean;
  data?: TOutput;
  error?: string;
  durationMs: number;
  memoryUsedMb?: number;
}

export interface SandboxRunnerPort {
  run<TInput = unknown, TOutput = unknown>(
    task: SandboxTask<TInput>,
  ): Promise<SandboxResult<TOutput>>;
}

export const SANDBOX_RUNNER_TOKEN = Symbol('SANDBOX_RUNNER_PORT');
