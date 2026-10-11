import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { LoggerService } from '../../logger/logger.service';

@Injectable()
export class LoggerInterceptor implements NestInterceptor {
  private readonly logger = LoggerService.getInstance('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const res = http.getResponse<FastifyReply>();

    const method = req.method || 'GET';
    const url = req.url || '/';
    const startTime = Date.now();
    const requestId =
      (req.id as string) ||
      (req.headers?.['x-request-id'] as string) ||
      '';

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startTime;
          const statusCode = res.statusCode || 200;
          this.logger.http(method, url, statusCode, duration, requestId);
        },
        error: (err: unknown) => {
          const duration = Date.now() - startTime;
          const errorObj = err as
            | { status?: number; statusCode?: number }
            | undefined;
          const statusCode = errorObj?.status || errorObj?.statusCode || 500;
          this.logger.http(method, url, statusCode, duration, requestId);
        },
      }),
    );
  }
}
