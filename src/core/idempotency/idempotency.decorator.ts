import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'flux:idempotent_operation';

/**
 * Decorator to explicitly mark a controller method as requiring idempotent execution
 */
export const Idempotent = (options: { ttlSeconds?: number } = {}) =>
  SetMetadata(IDEMPOTENT_KEY, options);
