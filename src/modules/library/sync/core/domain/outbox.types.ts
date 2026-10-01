export interface OutboxEventRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: any;
  status: string;
  retryCount: number;
  userId: string;
  projectId?: string | null;
  createdAt: Date;
  processedAt?: Date | null;
  [key: string]: any;
}

export interface OutboxDispatchHandler {
  handle(event: OutboxEventRecord, signal?: AbortSignal): Promise<void>;
}

export type { DomainEventEnvelope } from '../ports/event-publisher.port';
