import { Injectable, NestMiddleware, ConflictException } from '@nestjs/common';

const idempotencyStore = new Map<
  string,
  { status: 'processing' | 'completed'; response?: unknown; timestamp: number }
>();

// Clean up keys older than 10 minutes periodically
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of idempotencyStore.entries()) {
    if (now - val.timestamp > 600000) {
      idempotencyStore.delete(key);
    }
  }
}, 300000);
cleanupTimer.unref?.();

interface IdempotentRequest {
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
  path?: string;
  user?: { id?: string };
}

interface IdempotentResponse {
  status(code: number): IdempotentResponse;
  json(body: unknown): unknown;
}

/**
 * Idempotency Middleware for Distributed Systems.
 * Ensures mutating operations (POST, PUT, PATCH, DELETE) with X-Idempotency-Key
 * are processed exactly once, even during client retries.
 */
@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  use(
    req: IdempotentRequest,
    res: IdempotentResponse,
    next: (error?: unknown) => void,
  ) {
    const idempotencyKey = req.headers?.['x-idempotency-key'] as
      string | undefined;

    if (!idempotencyKey || req.method === 'GET' || req.method === 'HEAD') {
      return next();
    }

    const rawUserId = req.user?.id || req.headers?.['x-user-id'] || 'anon';
    const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
    const key = `${userId}:${req.method}:${req.path}:${idempotencyKey}`;
    const existing = idempotencyStore.get(key);

    if (existing) {
      if (existing.status === 'processing') {
        throw new ConflictException(
          'A request with this idempotency key is currently processing. Please retry later.',
        );
      }
      if (existing.status === 'completed' && existing.response) {
        return res.status(200).json(existing.response);
      }
    }

    // Mark as in-flight
    idempotencyStore.set(key, { status: 'processing', timestamp: Date.now() });

    // Intercept response json to cache completed output
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      idempotencyStore.set(key, {
        status: 'completed',
        response: body,
        timestamp: Date.now(),
      });
      return originalJson(body);
    };

    next();
  }
}
