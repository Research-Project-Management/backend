import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * OpenAPI / Swagger Specification Setup for Flux API.
 * Enabled in development and staging by default, opt-in in production via ENABLE_SWAGGER=true.
 */
export function setupSwagger(app: NestFastifyApplication): void {
  const isProd = process.env.NODE_ENV === 'production';
  const shouldEnableSwagger = !isProd || process.env.ENABLE_SWAGGER === 'true';

  if (!shouldEnableSwagger) {
    return;
  }

  const config = new DocumentBuilder()
    .setTitle('Flux API')
    .setDescription(
      'Production RESTful & Realtime API for Flux — High-performance Collaborative Research & LaTeX Platform. Built with NestJS, Fastify, and Prisma on PostgreSQL.',
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
    .addTag(
      'Chat',
      'Unified Messenger, Project Channels, Direct Messages, and Friendships',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}
