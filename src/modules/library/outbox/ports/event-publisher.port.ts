export const EVENT_PUBLISHER_PORT = Symbol('EVENT_PUBLISHER_PORT');

export interface DomainEventEnvelope<T = any> {
  eventId: string;
  workspaceId: string | null;
  aggregateId: string;
  eventType: string;
  payload: T;
  createdAt: Date;
  schemaVersion?: number;
  traceId?: string;
}

export interface IEventPublisherPort {
  publish<T = any>(envelope: DomainEventEnvelope<T>): Promise<void>;
}
