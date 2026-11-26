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

import { NestFactory, Reflector } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import {
  GlobalExceptionFilter,
  LoggerService,
  LoggerInterceptor,
  TransformInterceptor,
  IdempotencyInterceptor,
  IdempotencyService,
} from './core';
import { setupFastifyPlugins } from './core/http/setup/plugins.setup';
import { setupCors } from './core/http/setup/cors.setup';
import { resolveTrustProxyConfig } from './core/http/setup/trust-proxy.setup';
import { setupSwagger } from './core/http/setup/swagger.setup';
import { AppModule } from './app.module';

// Standard process-level diagnostics for unhandled rejections and fatal errors
process.on('unhandledRejection', (reason: unknown) => {
  console.error(
    '[Unhandled Rejection]:',
    reason instanceof Error ? reason.stack || reason.message : reason,
  );
});

process.on('uncaughtException', (error: Error) => {
  console.error(
    '[Fatal Uncaught Exception]:',
    error?.stack || error?.message || error,
  );
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
});

async function bootstrap() {
  const logger = LoggerService.getInstance('Bootstrap');

  const trustProxyConfig = resolveTrustProxyConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: trustProxyConfig,
      bodyLimit: 50 * 1024 * 1024, // 50MB for LaTeX compilation logs and large documents
      pluginTimeout: 30000, // 30s timeout for async plugins initialization
      routerOptions: {
        caseSensitive: true, // Speeds up Radix Tree route lookup in find-my-way
        maxParamLength: 256, // Allow long UUIDs and deep route tokens
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

  // Modular HTTP Middlewares & Security Setup
  await setupFastifyPlugins(app);
  setupCors(app);
  setupSwagger(app);

  // Global Interceptors, Pipes & Filters
  const reflector = app.get(Reflector);
  let idempotencyService: IdempotencyService | undefined;
  try {
    idempotencyService = app.get(IdempotencyService, { strict: false });
  } catch {
    idempotencyService = undefined;
  }

  app.useGlobalInterceptors(
    new LoggerInterceptor(),
    new IdempotencyInterceptor(idempotencyService),
    new TransformInterceptor(reflector),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      stopAtFirstError: true, // Fail fast on invalid inputs to save CPU cycles
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());

  // Graceful Shutdown on SIGTERM/SIGINT with clean connection draining
  app.enableShutdownHooks();
  const handleShutdown = (signal: string) => {
    logger.log(`Received ${signal}. Gracefully draining connections...`);
  };
  process.once('SIGTERM', () => handleShutdown('SIGTERM'));
  process.once('SIGINT', () => handleShutdown('SIGINT'));

  // Start HTTP Listener with Port Resilience
  await startServer(app, logger);
}

async function startServer(
  app: NestFastifyApplication,
  logger: LoggerService,
): Promise<void> {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const maxRetries = 4;
  let retryDelay = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await app.listen(port, host);
      logger.log(`🚀 NestJS + Fastify running on http://localhost:${port}`);
      logger.log(
        `📚 Swagger Documentation ready at http://localhost:${port}/docs`,
      );
      break;
    } catch (err: unknown) {
      const errorObj = err as { code?: string; message?: string } | undefined;
      if (errorObj?.code === 'EADDRINUSE') {
        if (attempt < maxRetries) {
          logger.warn(
            `⚠️ Port ${port} is busy (attempt ${attempt}/${maxRetries}). Retrying in ${retryDelay}ms after lingering socket release...`,
          );
          await new Promise((res) => setTimeout(res, retryDelay));
          retryDelay *= 1.5;
          continue;
        }
        logger.error(
          `❌ Port ${port} is already in use by another process after ${maxRetries} attempts. Please terminate the lingering process or run: Get-NetTCPConnection -LocalPort ${port}`,
        );
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(`❌ Server failed to start on port ${port}: ${errorMsg}`);
      }
      process.exit(1);
    }
  }
}

bootstrap().catch((err) => {
  console.error('[Fatal Bootstrap Exception]:', err);
  process.exit(1);
});
