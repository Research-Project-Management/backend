import { resolveServiceUrl } from '../../utils/public-urls';
import { ConfigService } from '@nestjs/config';
import type { BullRootModuleOptions } from '@nestjs/bullmq';

/**
 * Standard BullMQ & Redis connection provider for NestJS.
 * Shared across AppModule (Web API) and WorkerModule (Headless Workers)
 * to ensure uniform retry policies, cleanup thresholds, and socket resilience.
 */
export function getBullMqConfig(config: ConfigService): BullRootModuleOptions {
  const redisUrl = resolveServiceUrl(
    'REDIS_URL',
    config.get<string>('REDIS_URL') || process.env.REDIS_URL,
    'redis://localhost:6379',
  );

  let host = 'localhost';
  let port = 6379;
  let password: string | undefined;
  let username: string | undefined;
  let isTls = false;

  try {
    const parsed = new URL(redisUrl);
    host = parsed.hostname || 'localhost';
    port = parseInt(parsed.port || '6379', 10);
    if (parsed.password) password = decodeURIComponent(parsed.password);
    if (parsed.username && parsed.username !== 'default') {
      username = decodeURIComponent(parsed.username);
    }
    if (parsed.protocol === 'rediss:' || redisUrl.startsWith('rediss://')) {
      isTls = true;
    }
  } catch {
    // fallback to defaults
  }

  return {
    connection: {
      host,
      port,
      password,
      username,
      ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      keepAlive: 10000,
      retryStrategy: (times) => Math.min(times * 500, 3000),
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  };
}
