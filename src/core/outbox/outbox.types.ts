export interface EnqueueOutboxInput {
  aggregateId: string;
  eventType: string; // e.g. "library.item.created", "storage.file.deleted"
  payload: Record<string, unknown>;
}

export interface OutboxDispatchResult {
  processed: number;
  errors: number;
}
