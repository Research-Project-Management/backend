import { isUUID } from 'class-validator';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/submission.types';
import { Prisma } from '@prisma/client';

export function resolveScope(
  scopeId: string,
  envelope: IngestionSubmissionEnvelope,
): { userId: string; projectId?: string } {
  const isProject =
    Boolean(scopeId) &&
    scopeId !== 'user' &&
    scopeId !== 'me' &&
    scopeId !== envelope.userId &&
    isUUID(scopeId);
  const userId = envelope.userId || (scopeId !== 'user' ? scopeId : 'system');
  const projectId = envelope.projectId || (isProject ? scopeId : undefined);
  return { userId, projectId };
}

export function getSubmissionPayloadLabel(
  payload: IngestionSubmissionEnvelope['payload'],
): string | undefined {
  if ('filename' in payload && payload.filename) return payload.filename;
  if ('url' in payload && payload.url) return payload.url;
  if ('value' in payload && payload.value) return payload.value;
  return undefined;
}

export function getSubmissionPayloadSize(
  payload: IngestionSubmissionEnvelope['payload'],
): number {
  return 'size' in payload && typeof payload.size === 'number' ? payload.size : 0;
}

export function markErrStatusTransitioned(err: unknown): void {
  if (err && typeof err === 'object') {
    Object.defineProperty(err, '__runStatusTransitioned', {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
}

export function createSingleItemExecutionLog(params: {
  sourceLabel: string;
  itemTitle: string;
  itemId?: string;
  status: 'SUCCEEDED' | 'DUPLICATE';
}): Prisma.InputJsonValue {
  const isDup = params.status === 'DUPLICATE';
  return {
    total: 1,
    processed: 1,
    succeeded: isDup ? 0 : 1,
    duplicates: isDup ? 1 : 0,
    failed: 0,
    percentage: 100,
    status: 'COMPLETED',
    currentTitle: params.itemTitle,
    items: [
      {
        title: params.sourceLabel,
        itemName: params.itemTitle,
        status: params.status,
        itemId: params.itemId,
      },
    ],
  } as unknown as Prisma.InputJsonValue;
}
