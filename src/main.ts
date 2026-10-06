import 'dotenv/config';
// In-process worker enabled trigger

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
import {
  isSensitiveAuthRoute,
  isSensitiveScrapeRoute,
} from './core/utils/rate-limit.util';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './core/filters/exception.filter';
import { LoggerService } from './core/logger/logger.service';
import { LoggerInterceptor } from './core/logger/logger.interceptor';

import { Reflector } from '@nestjs/core';
import { TransformInterceptor } from './core/interceptors/transform.interceptor';
import { IdempotencyInterceptor } from './core/idempotency/idempotency.interceptor';
import { IdempotencyService } from './core/idempotency/idempotency.service';

// Enable native JSON serialization for PostgreSQL BigInt types across all HTTP endpoints
if (typeof (BigInt.prototype as any).toJSON !== 'function') {
  (BigInt.prototype as any).toJSON = function () {
    const num = Number(this);
    return Number.isSafeInteger(num) ? num : this.toString();
  };
}

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
  await app.register(multipart as any, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
    },
  });

  // Security Headers (Helmet)
  await app.register(helmet as any, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  // Rate Limiting (Throttle & Brute-force protection)
  const isProd = process.env.NODE_ENV === 'production';
  await app.register(rateLimit as any, {
    timeWindow: '1 minute',
    max: (req: any) => {
      const url = req.raw?.url || '';
      // Throttle sensitive auth endpoints (120 req/min in dev, 15 req/min in prod)
      if (isSensitiveAuthRoute(url)) {
        return isProd ? 15 : 120;
      }
      // Throttle sensitive scraping/URL-capture endpoints to protect Zotero Translation container (120 in dev, 30 in prod)
      if (isSensitiveScrapeRoute(url)) {
        return isProd ? 30 : 120;
      }
      return isProd ? 150 : 600;
    },
    keyGenerator: (req: any) => {
      const url = req.raw?.url || '';
      if (isSensitiveAuthRoute(url)) {
        return `auth:${req.ip}`;
      }
      if (isSensitiveScrapeRoute(url)) {
        return `scrape:${req.ip}`;
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

      // 2. Allow any localhost / 127.0.0.1 / private LAN IP origins
      const isLocalOrigin =
        /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(
          normalizedOrigin,
        );
      if (isLocalOrigin) {
        return callback(null, true);
      }

      // 3. Dynamic match for Vercel preview / production deployments (*.vercel.app)
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
    } catch (err: any) {
      if (err?.code === 'EADDRINUSE') {
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
        logger.error(
          `❌ Server failed to start on port ${port}: ${err?.message || err}`,
        );
      }
      process.exit(1);
    }
  }
}

bootstrap().catch((err) => {
  console.error('[Fatal Bootstrap Exception]:', err);
  process.exit(1);
});
