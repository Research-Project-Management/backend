import { OutboxEvent } from '@prisma/client';

export interface OutboxDispatchHandler {
  handle(event: OutboxEvent, signal?: AbortSignal): Promise<void>;
}

export type { DomainEventEnvelope } from '../ports/event-publisher.port';
