export interface IdempotentConsumerOptions<T = unknown> {
  consumer: string;
  eventId: string;
  leaseTtlSeconds?: number;
  retentionTtlSeconds?: number;
  handler: () => Promise<T>;
}

export interface IdempotentResult<T = unknown> {
  executed: boolean;
  skipped: boolean;
  reason?: 'ALREADY_COMPLETED' | 'IN_FLIGHT';
  result?: T;
}

export const IDEMPOTENT_CONSUMER = Symbol('IDEMPOTENT_CONSUMER');

export interface IIdempotentConsumer {
  executeIdempotent<T>(
    options: IdempotentConsumerOptions<T>,
  ): Promise<IdempotentResult<T>>;
}
