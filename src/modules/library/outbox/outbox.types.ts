import { OutboxEvent } from '@prisma/client';

export interface OutboxDispatchHandler {
  handle(event: OutboxEvent, signal?: AbortSignal): Promise<void>;
}

export interface DomainEventEnvelope<T = any> {
  eventId: string;
  workspaceId: string;
  aggregateId: string;
  eventType: string;
  payload: T;
  createdAt: Date;
}
