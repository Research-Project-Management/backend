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

// Standard process-level diagnostics for unhandled rejections and fatal errors
process.on('unhandledRejection', (reason: unknown) => {
  console.error(
    '[Worker Unhandled Rejection]:',
    reason instanceof Error ? reason.stack || reason.message : reason,
  );
});

process.on('uncaughtException', (error: Error) => {
  console.error(
    '[Worker Fatal Uncaught Exception]:',
    error?.stack || error?.message || error,
  );
  process.exit(1);
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
