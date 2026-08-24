import 'tsconfig-paths/register';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './core/filters/global-exception.filter';
import { AppLogger } from './core/logger/app-logger.service';
import { LoggingInterceptor } from './core/logger/logging.interceptor';

async function bootstrap() {
  const logger = AppLogger.getInstance('Bootstrap');
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    {
      logger,
      bufferLogs: true,
    },
  );

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
  await app.register(rateLimit as any, {
    max: 150,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', 'localhost'],
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.',
    }),
  });

  // Global Interceptors, Pipes & Filters
  app.useGlobalInterceptors(new LoggingInterceptor());

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

  // CORS Policy
  app.enableCors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:5173',
      'http://localhost:2915',
      'http://localhost:2916',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:2915',
      ...(process.env.ORIGINS
        ? process.env.ORIGINS.split(',').map((o) => o.trim())
        : []),
    ],
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'X-Requested-With',
      'Range',
      'Origin',
    ],
    exposedHeaders: ['Content-Range', 'X-Total-Count'],
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
    .addTag('Organization', 'Workspaces, Projects, Members, and Roles')
    .addTag(
      'Storage',
      'Cloudflare R2 Files, Presigned URLs, Virtual Tree, Labels',
    )
    .addTag('Library', 'Academic Papers, CSL Metadata, BibTeX, Collections')
    .addTag(
      'Manuscript',
      'LaTeX Editor Pages, Hierarchies, Snapshots, Versions',
    )
    .addTag('Planning', 'Kanban Tasks, Priorities, Checklists, Cycles')
    .addTag(
      'Collaboration',
      'Page Line Comments, Task Reactions, Sticky Canvas',
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

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`🚀 NestJS + Fastify running on http://localhost:${port}`);
  logger.log(`📚 Swagger Documentation ready at http://localhost:${port}/docs`);
}
bootstrap();
