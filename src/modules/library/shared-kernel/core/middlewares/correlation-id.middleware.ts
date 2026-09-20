import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: any, res: any, next: (error?: any) => void) {
    const correlationId =
      (req.headers?.['x-correlation-id'] as string) || randomUUID();
    if (req.headers) {
      req.headers['x-correlation-id'] = correlationId;
    }
    if (typeof res.setHeader === 'function') {
      res.setHeader('X-Correlation-Id', correlationId);
    } else if (typeof res.header === 'function') {
      res.header('X-Correlation-Id', correlationId);
    }
    next();
  }
}
