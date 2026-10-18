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

export const IDEMPOTENT_CONSUMER_PORT = Symbol('IDEMPOTENT_CONSUMER_PORT');

export abstract class IdempotentConsumerService {
  abstract executeIdempotent<T>(
    options: IdempotentConsumerOptions<T>,
  ): Promise<IdempotentResult<T>>;
}
