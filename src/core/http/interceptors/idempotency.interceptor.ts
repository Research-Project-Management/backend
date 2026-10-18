import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { Observable, of, from } from 'rxjs';
import { mergeMap, tap } from 'rxjs/operators';
import { IdempotencyService } from '../../infrastructure/idempotency/idempotency.service';
import { createHash } from 'crypto';
import { isUuid, NIL_UUID } from '../../utils/uuid.util';

import type { FastifyRequest, FastifyReply } from 'fastify';

interface AuthenticatedRequest extends FastifyRequest {
  user?: {
    id?: string;
    sub?: string;
  };
  params: {
    projectId?: string;
    [key: string]: unknown;
  };
  body: unknown;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Optional() private readonly idempotencyService?: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<AuthenticatedRequest>();
    const reply = http.getResponse<FastifyReply>();

    // Only apply to mutating requests: POST, PUT, PATCH, DELETE
    const method = (req.method || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return next.handle();
    }

    const headers = req.headers as Record<string, string | undefined>;
    const idempotencyKey =
      headers?.['idempotency-key'] || headers?.['x-idempotency-key'];

    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return next.handle();
    }

    const cleanKey = idempotencyKey.trim();
    if (!cleanKey) return next.handle();

    if (!this.idempotencyService) {
      return next.handle();
    }

    const rawUserId = req.user?.id || req.user?.sub;
    const userId = rawUserId && isUuid(rawUserId) ? rawUserId : NIL_UUID;

    const bodyObj =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : undefined;
    const rawProjectId =
      typeof req.params?.projectId === 'string'
        ? req.params.projectId
        : typeof bodyObj?.projectId === 'string'
          ? bodyObj.projectId
          : undefined;
    const projectId =
      rawProjectId && isUuid(rawProjectId) ? rawProjectId : undefined;

    const requestHash = createHash('sha256')
      .update(`${method}:${req.url || ''}:${JSON.stringify(req.body || {})}`)
      .digest('hex');

    return from(
      this.idempotencyService.checkKey(
        cleanKey,
        userId,
        projectId,
        requestHash,
      ),
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
}

