import { ConfigService } from '@nestjs/config';
import type { BullRootModuleOptions } from '@nestjs/bullmq';
import { resolveLaneRedisUrl } from '../redis/client.factory';

/**
 * Single source of truth for all active BullMQ queues in Flux (domain:action).
 * CLSI compiles synchronously over HTTP (flux_clsi) and does NOT use BullMQ.
 */
export const QUEUES = {
  AI_INDEX: 'ai:index',
  FILE_CAS: 'file:cas',
  FILE_MEDIA: 'file:media',
  FILE_CLEANUP: 'file:cleanup',
  LIB_INGEST: 'lib:ingest',
  LIB_OUTBOX: 'lib:outbox',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUES);

/**
 * Bounded retention defaults for 140MB `noeviction` Redis:
 * - max 200 completed jobs or 1h per queue
 * - max 500 failed jobs or 3d per queue for DLQ inspection
 */
export const JOB_DEFAULTS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 2_000,
  },
  removeOnComplete: {
    age: 3_600,
    count: 200,
  },
  removeOnFail: {
    age: 3 * 86_400,
    count: 500,
  },
} as const;

export function getQueueConfig(config: ConfigService): BullRootModuleOptions {
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
      enableOfflineQueue: true,
      keepAlive: 10_000,
      retryStrategy: (times) => Math.min(times * 500, 3_000),
    },
    defaultJobOptions: JOB_DEFAULTS,
  };
}
