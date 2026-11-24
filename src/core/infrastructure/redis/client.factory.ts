import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';
import { resolveRedisUrl } from '../../utils/public-urls';

export type RedisLane = 'cache' | 'pubsub' | 'queue';

const LANE_ENV_KEY: Record<RedisLane, string> = {
  cache: 'REDIS_CACHE_URL',
  pubsub: 'REDIS_REALTIME_URL',
  queue: 'REDIS_QUEUE_URL',
};

export function isRedisDisabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' || process.env.DISABLE_REDIS === 'true'
  );
}

/**
 * Resolves the Redis URL for a specific infrastructure lane,
 * falling back to shared `REDIS_URL` when a lane-specific URL is not set.
 */
export function resolveLaneRedisUrl(
  config: ConfigService | undefined,
  lane: RedisLane,
): string {
  const envKey = LANE_ENV_KEY[lane];
  const rawUrl =
    config?.get<string>(envKey) ||
    config?.get<string>('REDIS_URL') ||
    process.env[envKey] ||
    process.env.REDIS_URL;

  return resolveRedisUrl(rawUrl, envKey);
}

export interface CreateRedisClientOptions {
  label: string;
  logger?: Logger;
  maxRetries?: number;
  lazyConnect?: boolean;
  enableOfflineQueue?: boolean;
  maxRetriesPerRequest?: number | null;
}

/**
 * Factory for standardized ioredis clients across Cache, Pub/Sub, and IO Adapter lanes.
 */
export function createRedisClient(
  url: string,
  options: CreateRedisClientOptions,
): Redis {
  const maxRetries = options.maxRetries ?? 3;
  const logger = options.logger ?? new Logger(`RedisFactory:${options.label}`);

  const clientOptions: RedisOptions = {
    maxRetriesPerRequest:
      options.maxRetriesPerRequest !== undefined
        ? options.maxRetriesPerRequest
        : 1,
    retryStrategy: (times: number) => {
      if (times > maxRetries) {
        logger.warn(
          `${options.label} Redis connection failed after ${maxRetries} attempts. Operating in fallback mode.`,
        );
        return null;
      }
      return Math.min(times * 500, 2000);
    },
    lazyConnect: options.lazyConnect ?? true,
    enableOfflineQueue: options.enableOfflineQueue ?? false,
  };

  return new Redis(url, clientOptions);
}

/**
 * Gracefully quits an ioredis client and falls back to hard disconnect on error.
 */
export async function closeRedisClient(client: Redis | null): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    try {
      client.disconnect();
    } catch {
      // ignore disconnect error
    }
  }
}

/**
 * Adds bounded random jitter (default up to +15%) to prevent Cache Avalanche
 * when many keys are seeded at the same time.
 */
export function applyTtlJitter(ttlSeconds: number, jitterRatio = 0.15): number {
  if (ttlSeconds <= 0 || jitterRatio <= 0) {
    return ttlSeconds;
  }
  const maxExtra = Math.max(1, Math.floor(ttlSeconds * jitterRatio));
  const extra = Math.floor(Math.random() * (maxExtra + 1));
  return ttlSeconds + extra;
}
