import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { BYPASS_ENVELOPE_KEY } from '../decorators/bypass-envelope.decorator';
import { ApiResponseEnvelope } from '../types/api-response.interface';

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, unknown> {
  constructor(@Optional() private readonly reflector?: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const isBypassed = this.reflector?.getAllAndOverride<boolean>(
      BYPASS_ENVELOPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isBypassed) {
      return next.handle();
    }

    const httpContext = context.switchToHttp();
    const response = httpContext.getResponse();

    return next.handle().pipe(
      map((data) => {
        // If raw headers or reply were already sent (e.g. streaming SSE or file buffers), pass through
        if (response?.sent || response?.raw?.headersSent) {
          return data;
        }

        // If data is a redirect descriptor (e.g. from @Redirect()), pass through without enveloping
        if (
          data &&
          typeof data === 'object' &&
          'url' in data &&
          typeof data.url === 'string'
        ) {
          return data;
        }

        // If data is already enveloped, return as is
        if (
          data &&
          typeof data === 'object' &&
          'success' in data &&
          'data' in data
        ) {
          return {
            ...data,
            timestamp: data.timestamp || new Date().toISOString(),
          };
        }

        // If data is a standard paginated result ({ items: [], pagination: {} })
        if (
          data &&
          typeof data === 'object' &&
          'items' in data &&
          'pagination' in data &&
          Array.isArray(data.items)
        ) {
          return {
            success: true,
            data: data.items,
            pagination: data.pagination,
            timestamp: new Date().toISOString(),
          };
        }

        return {
          success: true,
          data: data === undefined ? null : data,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
