import { resolveLaneRedisUrl } from '../redis/client.factory';
import { ConfigService } from '@nestjs/config';
import type { BullRootModuleOptions } from '@nestjs/bullmq';

export const MANUSCRIPT_CLSI_QUEUE = 'MANUSCRIPT_CLSI_QUEUE';
export const CITATION_SYNC_QUEUE = 'CITATION_SYNC_QUEUE';

/**
 * Standard BullMQ & Redis connection provider for NestJS.
 * Shared across AppModule (Web API) and WorkerModule (Headless Workers)
 * to ensure uniform retry policies, cleanup thresholds, and socket resilience.
 */
export function getBullMqConfig(config: ConfigService): BullRootModuleOptions {
  const redisUrl = resolveLaneRedisUrl(config, 'queue');

  let host = '127.0.0.1';
  let port = 31679;
  let password: string | undefined;
  let username: string | undefined;
  let isTls = false;

  try {
    const parsed = new URL(redisUrl);
    host = parsed.hostname || '127.0.0.1';
    port = parseInt(parsed.port || '31679', 10);
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
