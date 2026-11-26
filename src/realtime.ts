process.env.REALTIME_MODE = 'true';

import 'dotenv/config';

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tsConfigPaths = require('tsconfig-paths');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  const isDist = __dirname.includes('dist');
  tsConfigPaths.register({
    baseUrl: isDist ? __dirname : path.resolve(__dirname, '..'),
    paths: isDist ? { '@/*': ['*'] } : { '@/*': ['src/*'] },
  });
} catch {
  // tsconfig-paths fallback
}

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import {
  GlobalExceptionFilter,
  LoggerService,
  RedisIoAdapter,
  resolveLaneRedisUrl,
} from './core';
import { setupCors } from './core/http/setup/cors.setup';
import { resolveTrustProxyConfig } from './core/http/setup/trust-proxy.setup';
import { REALTIME_NAMESPACES, RealtimeConfigService } from './modules/realtime';
import { RealtimeServiceAppModule } from './realtime.module';

process.on('unhandledRejection', (reason: unknown) => {
  console.error(
    '[Realtime Unhandled Rejection]:',
    reason instanceof Error ? reason.stack || reason.message : reason,
  );
});

process.on('uncaughtException', (error: Error) => {
  console.error(
    '[Realtime Fatal Uncaught Exception]:',
    error?.stack || error?.message || error,
  );
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
});

async function bootstrap(): Promise<void> {
  const logger = LoggerService.getInstance('RealtimeBootstrap');

  const trustProxyConfig = resolveTrustProxyConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    RealtimeServiceAppModule,
    new FastifyAdapter({
      trustProxy: trustProxyConfig,
      bodyLimit: 25 * 1024 * 1024,
      pluginTimeout: 30000,
      routerOptions: {
        caseSensitive: true,
        maxParamLength: 256,
      },
      requestIdHeader: 'x-request-id',
      genReqId: (req: IncomingMessage | Http2ServerRequest): string => {
        const incoming = req.headers['x-request-id'];
        if (
          typeof incoming === 'string' &&
          incoming.length > 0 &&
          incoming.length <= 128
        ) {
          return incoming;
        }
        return randomUUID();
      },
    }),
    {
      logger,
      bufferLogs: true,
    },
  );
  app.useLogger(logger);

  const redisUrl = resolveLaneRedisUrl(undefined, 'pubsub');
  let realtimeConfig: RealtimeConfigService | undefined;
  try {
    realtimeConfig = app.get(RealtimeConfigService, { strict: false });
  } catch {
    realtimeConfig = undefined;
  }

  const redisIoAdapter = new RedisIoAdapter(
    app,
    realtimeConfig?.getTransportConfig(),
  );
  await redisIoAdapter.connectToRedis(redisUrl);
  app.useWebSocketAdapter(redisIoAdapter);

  setupCors(app);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      stopAtFirstError: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  app.enableShutdownHooks();
  const handleShutdown = async (signal: string) => {
    logger.log(
      `Received ${signal}. Gracefully draining Realtime WS & Yjs sessions...`,
    );
    try {
      await redisIoAdapter.close();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Error during redisIoAdapter shutdown: ${msg}`);
    }
  };
  process.once('SIGTERM', () => void handleShutdown('SIGTERM'));
  process.once('SIGINT', () => void handleShutdown('SIGINT'));

  await startServer(app, logger);
}

async function startServer(
  app: NestFastifyApplication,
  logger: LoggerService,
): Promise<void> {
  const port = Number(process.env.REALTIME_PORT || process.env.PORT || 3014);
  const host = process.env.HOST || '0.0.0.0';
  const maxRetries = 4;
  let retryDelay = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await app.listen(port, host);
      logger.log(
        `⚡ [Flux Realtime Service] running on http://${host}:${port}`,
      );
      logger.log(
        `🔌 Namespaces active: [${Object.values(REALTIME_NAMESPACES).join(', ')}]`,
      );
      logger.log(`🩺 Health probe: http://localhost:${port}/health/liveness`);
      logger.log(
        `🛡️  Internal control plane: http://localhost:${port}/internal/realtime/*`,
      );
      break;
    } catch (err: unknown) {
      const errorObj = err as { code?: string } | undefined;
      if (errorObj?.code === 'EADDRINUSE') {
        if (attempt < maxRetries) {
          logger.warn(
            `⚠️ Port ${port} is busy (attempt ${attempt}/${maxRetries}). Retrying in ${retryDelay}ms...`,
          );
          await new Promise((res) => setTimeout(res, retryDelay));
          retryDelay *= 1.5;
          continue;
        }
        logger.error(
          `❌ Port ${port} is already in use after ${maxRetries} attempts.`,
        );
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          `❌ Realtime server failed to start on port ${port}: ${errorMsg}`,
        );
      }
      process.exit(1);
    }
  }
}

bootstrap().catch((err) => {
  console.error('[Realtime Fatal Bootstrap Exception]:', err);
  process.exit(1);
});
