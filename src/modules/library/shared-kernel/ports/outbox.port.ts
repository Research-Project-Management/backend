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

export const OUTBOX_REGISTRY_PORT = Symbol('OUTBOX_REGISTRY_PORT');

export interface IOutboxRegistry {
  registerHandler(eventType: string, handler: OutboxDispatchHandler): void;
  hasHandler?(eventType: string): boolean;
}
