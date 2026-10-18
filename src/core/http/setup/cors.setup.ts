import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { isOriginAllowed } from './allowed-origins';

/**
 * Enterprise Cross-Origin Resource Sharing (CORS) Configuration.
 * Delegates origin checking to shared isOriginAllowed function.
 */
export function setupCors(app: NestFastifyApplication): void {
  app.enableCors({
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin));
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
