import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import compression from '@fastify/compress';
import { constants as zlibConstants } from 'node:zlib';

/**
 * Route classifiers for rate limiting sensitivity
 */
export function isSensitiveAuthRoute(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  const path = rawUrl.split('?')[0].split('#')[0];
  const normalized = path.replace(/^\/api(?=\/)/, '');
  return (
    normalized.startsWith('/auth/login') ||
    normalized.startsWith('/auth/register') ||
    normalized.startsWith('/auth/refresh') ||
    normalized.startsWith('/auth/forgot-password') ||
    normalized.startsWith('/auth/reset-password') ||
    normalized.startsWith('/auth/change-password') ||
    normalized.startsWith('/auth/verify-email') ||
    normalized.startsWith('/auth/resend-verification') ||
    normalized.startsWith('/auth/oauth/exchange')
  );
}

export function isSensitiveScrapeRoute(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  const path = rawUrl.split('?')[0].split('#')[0];
  const normalized = path.replace(/^\/api(?:\/v1)?(?=\/)/, '');
  return (
    normalized.includes('/library/ingestion/capture-url') ||
    normalized.includes('/library/url-capture') ||
    normalized.includes('/ingestion/capture-url')
  );
}

/**
 * Fastify Plugins & Security Middleware Setup.
 * Configures Keep-Alive tuning, Correlation ID propagation, Response Compression,
 * Multipart Uploads, Helmet headers, and Dynamic Rate Limiting.
 */
export async function setupFastifyPlugins(
  app: NestFastifyApplication,
): Promise<void> {
  const fastifyInstance = app
    .getHttpAdapter()
    .getInstance() as unknown as FastifyInstance;

  // TCP Socket Keep-Alive Tuning (Reverse Proxy / Next.js Rewrite socket reuse)
  if (fastifyInstance?.server) {
    fastifyInstance.server.keepAliveTimeout = 65000; // 65s (exceeds 60s proxy timeouts)
    fastifyInstance.server.headersTimeout = 66000; // Must be strictly greater than keepAliveTimeout
  }

  // Correlation ID Response Header (echo or propagate x-request-id across all HTTP responses)
  fastifyInstance.addHook(
    'onSend',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.id) {
        reply.header('x-request-id', request.id);
      }
    },
  );

  // HTTP Response Compression (Brotli quality 4 + Gzip for low latency and minimal CPU overhead)
  await fastifyInstance.register(compression, {
    threshold: 1024, // Only compress responses >= 1KB
    encodings: ['br', 'gzip', 'deflate'],
    brotliOptions: {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      },
    },
  });

  // Multipart file uploads (Cloudflare R2 / S3 streaming)
  await fastifyInstance.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
    },
  });

  // Security Headers (Helmet)
  await fastifyInstance.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  // Rate Limiting (Throttle & Brute-force protection)
  const isProd = process.env.NODE_ENV === 'production';
  await fastifyInstance.register(rateLimit, {
    timeWindow: '1 minute',
    max: (req: FastifyRequest) => {
      const url = req.raw?.url || '';
      if (isSensitiveAuthRoute(url)) {
        return isProd ? 15 : 120;
      }
      if (isSensitiveScrapeRoute(url)) {
        return isProd ? 30 : 120;
      }
      return isProd ? 150 : 600;
    },
    keyGenerator: (req: FastifyRequest) => {
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
}
