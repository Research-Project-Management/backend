import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: any, res: any, next: (error?: any) => void) {
    const correlationId =
      (req.headers?.['x-correlation-id'] as string) ||
      (req.headers?.['x-request-id'] as string) ||
      randomUUID();
    const traceparent = req.headers?.['traceparent'] as string;

    if (req.headers) {
      req.headers['x-correlation-id'] = correlationId;
      req.headers['x-request-id'] = correlationId;
    }
    if (typeof res.setHeader === 'function') {
      res.setHeader('X-Correlation-Id', correlationId);
      res.setHeader('X-Request-Id', correlationId);
      if (traceparent) res.setHeader('traceparent', traceparent);
    } else if (typeof res.header === 'function') {
      res.header('X-Correlation-Id', correlationId);
      res.header('X-Request-Id', correlationId);
      if (traceparent) res.header('traceparent', traceparent);
    }
    next();
  }
}
