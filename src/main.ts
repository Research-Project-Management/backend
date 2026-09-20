try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('tsconfig-paths/register');
} catch {
  // tsconfig-paths is only required during development when paths are not rewritten by tsc-alias
}
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { RedisIoAdapter } from './core/adapters/redis-io.adapter';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { isSensitiveAuthRoute } from './core/utils/rate-limit.util';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './core/filters/exception.filter';
import { LoggerService } from './core/logger/logger.service';
import { LoggerInterceptor } from './core/logger/logger.interceptor';

import { Reflector } from '@nestjs/core';
import { TransformInterceptor } from './core/interceptors/transform.interceptor';
import { IdempotencyInterceptor } from './core/idempotency/idempotency.interceptor';
import { IdempotencyService } from './core/idempotency/idempotency.service';

// Process-level safety nets to prevent unexpected crashes from background socket resets or async events
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
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  const code = (err as any)?.code;
  return (
    TRANSIENT_NETWORK_ERRORS.some((e) => code === e || msg?.includes(e)) ||
    false
  );
}

process.on('unhandledRejection', (reason: unknown) => {
  if (isTransientNetworkError(reason)) {
    console.warn(
      '[Transient Socket Notice (unhandledRejection bypassed)]:',
      (reason as any)?.message || reason,
    );
    return;
  }
  console.error(
    '[Unhandled Rejection]:',
    reason instanceof Error ? reason.stack : reason,
  );
});

process.on('uncaughtException', (error: any) => {
  if (isTransientNetworkError(error)) {
    console.warn(
      '[Transient Socket Notice (uncaughtException bypassed)]:',
      error?.message || error,
    );
    return;
  }
  console.error(
    '[Uncaught Exception]:',
    error?.stack || error?.message || error,
  );
});

async function bootstrap() {
  const logger = LoggerService.getInstance('Bootstrap');

  const maxProxyHops = process.env.TRUST_PROXY_HOPS
    ? parseInt(process.env.TRUST_PROXY_HOPS, 10)
    : 1;

  const trustProxyConfig =
    process.env.TRUST_PROXY === 'false'
      ? false
      : process.env.TRUST_PROXY && process.env.TRUST_PROXY !== 'true'
        ? process.env.TRUST_PROXY
        : (_address: string, hop: number) => hop <= maxProxyHops;

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: trustProxyConfig }),
    {
      logger,
      bufferLogs: true,
    },
  );
  app.useLogger(logger);
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis(redisUrl);
  app.useWebSocketAdapter(redisIoAdapter);

  // Multipart file uploads (Cloudflare R2 / S3 streaming)
  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
    },
  });

  // Security Headers (Helmet)
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  // Rate Limiting (Throttle & Brute-force protection)
  const isProd = process.env.NODE_ENV === 'production';
  await app.register(rateLimit, {
    timeWindow: '1 minute',
    max: (req) => {
      const url = req.raw.url || '';
      // Throttle sensitive auth endpoints (120 req/min in dev, 15 req/min in prod)
      if (isSensitiveAuthRoute(url)) {
        return isProd ? 15 : 120;
      }
      return isProd ? 150 : 600;
    },
    keyGenerator: (req) => {
      const url = req.raw.url || '';
      if (isSensitiveAuthRoute(url)) {
        return `auth:${req.ip}`;
      }
      return req.ip;
    },
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.',
    }),
  });

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
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());

  // CORS Policy: Support local environments, custom domains, and Vercel deployments
  const rawOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:5173',
    'http://localhost:2915',
    'http://localhost:2916',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:2915',
    ...(process.env.CLIENT_URL ? [process.env.CLIENT_URL.trim()] : []),
    ...(process.env.ORIGINS
      ? process.env.ORIGINS.split(',').map((o) => o.trim())
      : []),
  ];

  const allowedOrigins = new Set<string>();
  rawOrigins.forEach((origin) => {
    if (origin) {
      allowedOrigins.add(origin.replace(/\/+$/, ''));
    }
  });

  app.enableCors({
    origin: (origin, callback) => {
      // Allow non-browser requests (Postman, curl, server-to-server)
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = origin.replace(/\/+$/, '');

      // 1. Exact match with allowed list
      if (allowedOrigins.has(normalizedOrigin)) {
        return callback(null, true);
      }

      // 2. Dynamic match for Vercel preview / production deployments (*.vercel.app)
      const isVercelOrigin =
        /^https:\/\/[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.vercel\.app$/.test(
          normalizedOrigin,
        );
      const isVercelConfigured =
        process.env.CLIENT_URL?.includes('.vercel.app') ||
        process.env.ALLOW_VERCEL_PREVIEW === 'true' ||
        process.env.NODE_ENV !== 'production';

      if (isVercelOrigin && isVercelConfigured) {
        return callback(null, true);
      }

      return callback(null, false);
    },
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'X-Requested-With',
      'Range',
      'Origin',
      'Idempotency-Key',
      'X-Idempotency-Key',
    ],
    exposedHeaders: [
      'Content-Range',
      'X-Total-Count',
      'Idempotent-Replay',
      'X-Idempotent-Key',
      'ETag',
      'Content-Length',
      'Content-Disposition',
      'Accept-Ranges',
    ],
    credentials: true,
  });

  // Graceful Shutdown on SIGTERM/SIGINT
  app.enableShutdownHooks();

  // Swagger OpenAPI Documentation
  const config = new DocumentBuilder()
    .setTitle('Research Project Management (RPM) API')
    .setDescription(
      'Enterprise RESTful API Documentation for Research Project Management. Built with NestJS 11, Fastify v5, and Prisma 7 on PostgreSQL.',
    )
    .setVersion('2.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        description: 'Enter your JWT Bearer token',
        in: 'header',
      },
      'JWT-auth',
    )
    .addTag(
      'Health',
      'System health checks, database liveness & readiness probes',
    )
    .addTag('Identity', 'Authentication, OAuth2, JWT Refresh, Profile')
    .addTag('Organization', 'Projects, Members, and Roles')
    .addTag(
      'Storage',
      'Cloudflare R2 Files, Presigned URLs, Virtual Tree, Labels',
    )
    .addTag('Library', 'Academic Papers, CSL Metadata, BibTeX, Collections')
    .addTag(
      'Manuscript',
      'LaTeX Editor Pages, Hierarchies, Snapshots, Versions',
    )
    .addTag('Planning', 'Work Items, Priorities, Relations, Cycles')
    .addTag(
      'Collaboration',
      'Page Line Comments, WorkItem Reactions, Sticky Canvas',
    )
    .addTag(
      'Intelligence',
      'Flux-AI Proxy, Streaming Chat, RAG Document Search',
    )
    .addTag('Activity', 'Activity Feed, Collaboration Stream, Recent Items')
    .addTag('Search', 'Global Search & Discovery')
    .addTag('Analytics', 'Workload Metrics, Velocity, Overview')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  app.enableShutdownHooks();

  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen(port, host);
    logger.log(`🚀 NestJS + Fastify running on http://localhost:${port}`);
    logger.log(
      `📚 Swagger Documentation ready at http://localhost:${port}/docs`,
    );
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      logger.error(
        `❌ Port ${port} is already in use by another process. Please terminate the lingering process or run: Get-NetTCPConnection -LocalPort ${port}`,
      );
    } else {
      logger.error(
        `❌ Server failed to start on port ${port}: ${err?.message || err}`,
      );
    }
    process.exit(1);
  }
}

bootstrap().catch((err) => {
  console.error('[Fatal Bootstrap Exception]:', err);
  process.exit(1);
});
