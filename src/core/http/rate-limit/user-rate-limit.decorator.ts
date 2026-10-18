import { SetMetadata } from '@nestjs/common';
import { RateLimitBucket } from './rate-limit.config';

export const USER_RATE_LIMIT_KEY = 'user_rate_limit';

export interface UserRateLimitOptions {
  bucket: RateLimitBucket;
  limit?: number;
  windowSeconds?: number;
}

export function UserRateLimit(
  bucketOrOptions: RateLimitBucket | UserRateLimitOptions,
): MethodDecorator & ClassDecorator {
  const options: UserRateLimitOptions =
    typeof bucketOrOptions === 'string'
      ? { bucket: bucketOrOptions }
      : bucketOrOptions;
  return SetMetadata(USER_RATE_LIMIT_KEY, options);
}
