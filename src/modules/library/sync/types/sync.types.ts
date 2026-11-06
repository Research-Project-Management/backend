import type { OutboxEvent } from '@prisma/client';
import type { PublishOutboxInput as CorePublishOutboxInput } from '@/modules/library/core';

export interface OutboxPublishInput extends CorePublishOutboxInput {
  dedupeKey?: string | null;
}

export type PublishOutboxInput = OutboxPublishInput;

export interface ClaimedOutboxEvent {
  event: OutboxEvent;
  isLeaseRecovery: boolean;
}

export interface CompactableChange {
  id?: string;
  seq: bigint | number | string;
  userId?: string | null;
  projectId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  version?: number;
  data?: unknown;
  createdAt?: Date | string;
}

export interface OutboxMetricsRecorder {
  incrementCounter(name: string, value?: number): number;
  setGauge(name: string, value: number): void;
  recordOutboxDispatch(durationMs: number, success: boolean): void;
}

export interface OutboxFailureDecision {
  isDeadLetter: boolean;
  nextRetryCount: number;
  delaySec?: number;
  nextRetryAt?: Date;
}

export interface OutboxDiagnosticSummary {
  workerId: string;
  registeredHandlers: string[];
  pendingCountsByType: Record<string, number>;
  totalPending: number;
  totalProcessing: number;
  oldestPendingAgeSeconds: number;
  unhandledEventTypes: string[];
}
