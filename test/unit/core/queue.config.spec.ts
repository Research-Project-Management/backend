import type { ConfigService } from '@nestjs/config';
import {
  getQueueConfig,
  JOB_DEFAULTS,
  QUEUE_NAMES,
  QUEUES,
} from '@/core/infrastructure/queue/queue.config';

describe('Queue Configuration & Registry', () => {
  const createMockConfig = (values: Record<string, string | undefined>) =>
    ({
      get: (key: string) => values[key],
    }) as unknown as ConfigService;

  it('registers all 6 active Flux queues using domain-action naming', () => {
    expect(QUEUE_NAMES).toHaveLength(6);
    expect(QUEUES).toEqual({
      AI_INDEX: 'ai-index',
      FILE_CAS: 'file-cas',
      FILE_MEDIA: 'file-media',
      FILE_CLEANUP: 'file-cleanup',
      LIB_INGEST: 'lib-ingest',
      LIB_OUTBOX: 'lib-outbox',
    });
  });

  it('enforces bounded retention for 140MB noeviction Redis and worker-safe offline queue', () => {
    const config = getQueueConfig(
      createMockConfig({ REDIS_QUEUE_URL: 'redis://127.0.0.1:31679' }),
    );

    expect(config.connection).toMatchObject({
      host: '127.0.0.1',
      port: 31679,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
    expect(config.defaultJobOptions).toEqual(JOB_DEFAULTS);
  });

  it('enables TLS when REDIS_QUEUE_URL uses rediss://', () => {
    const config = getQueueConfig(
      createMockConfig({
        REDIS_QUEUE_URL: 'rediss://user:pass@redis.example.com:6380',
      }),
    );

    expect(config.connection).toMatchObject({
      host: 'redis.example.com',
      port: 6380,
      username: 'user',
      password: 'pass',
      tls: { rejectUnauthorized: false },
    });
  });
});
