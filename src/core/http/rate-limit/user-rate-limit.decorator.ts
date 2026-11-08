import { SetMetadata } from '@nestjs/common';
import { RateLimitBucket } from './rate-limit.config';

export const USER_RATE_LIMIT_KEY = 'user_rate_limit';

export type RateLimitKeyType = 'user' | 'ip' | 'email' | 'user-or-ip';

export interface UserRateLimitRule {
  bucket: RateLimitBucket;
  limit?: number;
  windowSeconds?: number;
  keyType?: RateLimitKeyType;
}

export type UserRateLimitOptions =
  | RateLimitBucket
  | UserRateLimitRule
  | UserRateLimitRule[];

export function UserRateLimit(
  options: UserRateLimitOptions,
): MethodDecorator & ClassDecorator {
  const normalizedRules: UserRateLimitRule[] = Array.isArray(options)
    ? options
    : typeof options === 'string'
      ? [{ bucket: options }]
      : [options];

  return SetMetadata(USER_RATE_LIMIT_KEY, normalizedRules);
}
