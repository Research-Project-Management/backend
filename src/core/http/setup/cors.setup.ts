import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Enterprise Cross-Origin Resource Sharing (CORS) Configuration.
 * Supports local development, custom production domains, private LAN IPs, and Vercel preview environments.
 */
export function setupCors(app: NestFastifyApplication): void {
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
      'x-request-id',
      'X-Request-Id',
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
      'x-request-id',
      'X-Request-Id',
    ],
    credentials: true,
  });
}
