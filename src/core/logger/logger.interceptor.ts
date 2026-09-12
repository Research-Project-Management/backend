import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { LoggerService } from './logger.service';

@Injectable()
export class LoggerInterceptor implements NestInterceptor {
  private readonly logger = LoggerService.getInstance('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const method = req.method || 'GET';
    const url = req.url || '/';
    const startTime = Date.now();
    const requestId =
      req.headers?.['x-request-id'] ||
      Math.random().toString(36).substring(2, 8);

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startTime;
          const statusCode = res.statusCode || 200;
          this.logger.http(method, url, statusCode, duration, requestId);
        },
        error: (err) => {
          const duration = Date.now() - startTime;
          const statusCode = err.status || err.statusCode || 500;
          this.logger.http(method, url, statusCode, duration, requestId);
        },
      }),
    );
  }
}

export const LoggingInterceptor = LoggerInterceptor;
