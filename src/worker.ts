process.env.WORKER_MODE = 'true';

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('tsconfig-paths/register');
} catch {
  // tsconfig-paths is only required during development when paths are not rewritten by tsc-alias
}

import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { LoggerService } from './core/logger/logger.service';

const TRANSIENT_NETWORK_ERRORS = [
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECANCELED',
];

function isTransientNetworkError(err: unknown): boolean {
  if (!err) return false;
  const msg =
    err instanceof Error
      ? err.stack || err.message
      : typeof err === 'string'
        ? err
        : JSON.stringify(err);
  const code = (err as any)?.code;
  return (
    TRANSIENT_NETWORK_ERRORS.some((e) => code === e || msg?.includes(e)) ||
    false
  );
}

process.on('unhandledRejection', (reason: unknown) => {
  if (isTransientNetworkError(reason)) {
    console.warn(
      '[Worker Transient Socket Notice (unhandledRejection bypassed)]:',
      (reason as any)?.message || reason,
    );
    return;
  }
  console.error(
    '[Worker Unhandled Rejection]:',
    reason instanceof Error ? reason.stack : reason,
  );
});

process.on('uncaughtException', (error: any) => {
  if (isTransientNetworkError(error)) {
    console.warn(
      '[Worker Transient Socket Notice (uncaughtException bypassed)]:',
      error?.message || error,
    );
    return;
  }
  console.error(
    '[Worker Uncaught Exception]:',
    error?.stack || error?.message || error,
  );
});

async function bootstrap() {
  const logger = LoggerService.getInstance('WorkerBootstrap');

  logger.log('======================================================');
  logger.log('🚀 [Flux Dedicated Worker] Bootstrapping Background Node...');
  logger.log('⚙️  Runtime: NestJS ApplicationContext (Headless / Non-HTTP)');
  logger.log('======================================================');

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger,
  });

  app.enableShutdownHooks();

  logger.log('✅ [Flux Dedicated Worker] Successfully initialized.');
  logger.log(
    '📡 Subscribed queues: [LIBRARY_INGESTION_QUEUE, STORAGE_PROCESSING_QUEUE, DOCUMENT_COLLABORATION_QUEUE]',
  );
  logger.log('⚡ Ready to process background jobs...');
}

bootstrap().catch((err) => {
  console.error('[Worker Fatal Bootstrap Exception]:', err);
  process.exit(1);
});
