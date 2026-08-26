import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ConflictException,
  Logger,
  Optional,
} from '@nestjs/common';
import { Observable, of, from } from 'rxjs';
import { mergeMap, tap } from 'rxjs/operators';
import { IdempotencyService } from './idempotency.service';
import { createHash } from 'crypto';

interface LocalCacheEntry {
  body: any;
  statusCode: number;
  expiresAt: number;
  inProgress?: boolean;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);
  private static readonly memoryCache = new Map<string, LocalCacheEntry>();

  constructor(
    @Optional() private readonly idempotencyService?: IdempotencyService,
  ) {}

  static clearCacheForTesting(): void {
    IdempotencyInterceptor.memoryCache.clear();
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest<any>();
    const reply = http.getResponse<any>();

    // Only apply to mutating requests: POST, PUT, PATCH, DELETE
    const method = (req.method || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return next.handle();
    }

    const idempotencyKey = (req.headers?.['idempotency-key'] ||
      req.headers?.['x-idempotency-key']) as string | undefined;

    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return next.handle();
    }

    const cleanKey = idempotencyKey.trim();
    if (!cleanKey) return next.handle();

    const workspaceId =
      req.params?.workspaceId || req.body?.workspaceId || 'global';

    const requestHash = createHash('md5')
      .update(`${method}:${req.url || ''}:${JSON.stringify(req.body || {})}`)
      .digest('hex');

    // If IdempotencyService is injected (Prisma/Redis distributed setup)
    if (this.idempotencyService) {
      return from(this.idempotencyService.checkKey(cleanKey, workspaceId)).pipe(
        mergeMap((check) => {
          if (check.isDuplicate) {
            if (check.inProgress) {
              throw new ConflictException(
                'A mutation request with this Idempotency-Key is currently in progress. Please retry shortly.',
              );
            }
            if (typeof reply.header === 'function') {
              reply.header('Idempotent-Replay', 'true');
              reply.header('X-Idempotent-Key', cleanKey);
            }
            if (typeof reply.status === 'function') {
              reply.status(check.statusCode || 200);
            }
            return of(check.responseBody);
          }

          return from(
            this.idempotencyService!.lockKey(
              cleanKey,
              workspaceId,
              requestHash,
            ),
          ).pipe(
            mergeMap(() =>
              next.handle().pipe(
                tap({
                  next: (body) => {
                    const statusCode = reply.statusCode || 200;
                    void this.idempotencyService?.saveResult({
                      idempotencyKey: cleanKey,
                      workspaceId,
                      requestHash,
                      statusCode,
                      responseBody: body,
                    });
                  },
                  error: () => {
                    void this.idempotencyService?.unlockKey(
                      cleanKey,
                      workspaceId,
                    );
                  },
                }),
              ),
            ),
          );
        }),
      );
    }

    // In-memory fallback (e.g. standalone test context without DB)
    const existing = IdempotencyInterceptor.memoryCache.get(cleanKey);
    if (existing) {
      if (existing.expiresAt < Date.now()) {
        IdempotencyInterceptor.memoryCache.delete(cleanKey);
      } else if (existing.inProgress) {
        throw new ConflictException(
          'A mutation request with this Idempotency-Key is currently in progress. Please retry shortly.',
        );
      } else {
        if (typeof reply.header === 'function') {
          reply.header('Idempotent-Replay', 'true');
          reply.header('X-Idempotent-Key', cleanKey);
        }
        if (typeof reply.status === 'function') {
          reply.status(existing.statusCode || 200);
        }
        return of(existing.body);
      }
    }

    IdempotencyInterceptor.memoryCache.set(cleanKey, {
      body: null,
      statusCode: 200,
      expiresAt: Date.now() + 86400 * 1000,
      inProgress: true,
    });

    return next.handle().pipe(
      tap({
        next: (body) => {
          IdempotencyInterceptor.memoryCache.set(cleanKey, {
            body,
            statusCode: reply.statusCode || 200,
            expiresAt: Date.now() + 86400 * 1000,
            inProgress: false,
          });
        },
        error: () => {
          IdempotencyInterceptor.memoryCache.delete(cleanKey);
        },
      }),
    );
  }
}
