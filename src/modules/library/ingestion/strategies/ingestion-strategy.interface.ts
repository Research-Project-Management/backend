import { IngestionCommand, IngestionResult } from '../types/ingestion.types';
import { IngestionStatus } from '@prisma/client';

export interface IngestionExecutionContext {
  workspaceId: string;
  runId: string;
  requestHash: string;
  saveIdempotency: (
    workspaceId: string,
    idempotencyKey: string | undefined,
    requestHash: string,
    result: IngestionResult,
  ) => Promise<void>;
  updateRunStatus: (
    workspaceId: string,
    runId: string,
    status: IngestionStatus,
    meta?: { itemId?: string; completedAt?: Date; error?: string },
  ) => Promise<void>;
  withKeyLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
}

export interface IIngestionStrategy<
  TCommand extends IngestionCommand = IngestionCommand,
> {
  readonly source: TCommand['source'];
  canHandle(source: string): boolean;
  execute(
    command: TCommand,
    context: IngestionExecutionContext,
  ): Promise<IngestionResult>;
}
