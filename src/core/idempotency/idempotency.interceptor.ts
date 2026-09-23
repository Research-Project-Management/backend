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
import { isUuid, NIL_UUID } from '../utils/uuid.util';

interface LocalCacheEntry {
  body: any;
  statusCode: number;
  expiresAt: number;
  inProgress?: boolean;
  requestHash?: string;
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

    const rawUserId = req.user?.id || req.user?.sub;
    const userId = rawUserId && isUuid(rawUserId) ? rawUserId : NIL_UUID;

    const rawProjectId = req.params?.projectId || req.body?.projectId;
    const projectId =
      rawProjectId && isUuid(rawProjectId) ? rawProjectId : undefined;

    const requestHash = createHash('md5')
      .update(`${method}:${req.url || ''}:${JSON.stringify(req.body || {})}`)
      .digest('hex');

    // If IdempotencyService is injected (Prisma/Redis distributed setup)
    if (this.idempotencyService) {
      return from(
        this.idempotencyService.checkKey(cleanKey, userId, projectId),
      ).pipe(
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
              userId,
              requestHash,
              projectId,
            ),
          ).pipe(
            mergeMap(() =>
              next.handle().pipe(
                tap({
                  next: (body) => {
                    const statusCode = reply.statusCode || 200;
                    void this.idempotencyService?.saveResult({
                      idempotencyKey: cleanKey,
                      userId,
                      projectId,
                      requestHash,
                      statusCode,
                      responseBody: body,
                    });
                  },
                  error: () => {
                    void this.idempotencyService?.unlockKey(
                      cleanKey,
                      userId,
                      projectId,
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
    const scopedKey = `${projectId || NIL_UUID}:${userId}:${cleanKey}`;
    const existing = IdempotencyInterceptor.memoryCache.get(scopedKey);
    if (existing) {
      if (existing.expiresAt < Date.now()) {
        IdempotencyInterceptor.memoryCache.delete(scopedKey);
      } else if (existing.inProgress) {
        throw new ConflictException(
          'A mutation request with this Idempotency-Key is currently in progress. Please retry shortly.',
        );
      } else if (existing.requestHash && existing.requestHash !== requestHash) {
        throw new ConflictException(
          'Idempotency key was previously used with a different request payload',
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

    IdempotencyInterceptor.memoryCache.set(scopedKey, {
      body: null,
      statusCode: 200,
      expiresAt: Date.now() + 86400 * 1000,
      inProgress: true,
      requestHash,
    });

    return next.handle().pipe(
      tap({
        next: (body) => {
          IdempotencyInterceptor.memoryCache.set(scopedKey, {
            body,
            statusCode: reply.statusCode || 200,
            expiresAt: Date.now() + 86400 * 1000,
            inProgress: false,
            requestHash,
          });
        },
        error: () => {
          IdempotencyInterceptor.memoryCache.delete(scopedKey);
        },
      }),
    );
  }
}
