import { IngestDocumentDto, IngestionSourceType } from '../dto/translation.dto';
import { UnifiedAcademicMetadata } from '../../metadata/types/metadata.types';
import { SandboxResult, SandboxTask } from '@/core/sandbox/sandbox.types';

export interface SandboxExecutionOptions {
  timeoutMs?: number;
  memoryLimitMb?: number;
}

export interface SandboxExecutionResult<T = any> {
  success: boolean;
  data?: T;
  logs?: string[];
  error?: string;
}

export interface SandboxRunnerPort {
  run<TInput = unknown, TOutput = unknown>(
    task: SandboxTask<TInput>,
  ): Promise<SandboxResult<TOutput>>;
}

export interface IngestionResult {
  item: any;
  metadata: UnifiedAcademicMetadata;
  provenance: any;
  sourceType: IngestionSourceType;
}

export interface BatchIngestionResult {
  total: number;
  successful: number;
  failed: number;
  items: IngestionResult[];
  errors: Array<{ item: IngestDocumentDto; error: string }>;
}
