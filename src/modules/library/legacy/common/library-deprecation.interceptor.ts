import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class LibraryDeprecationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const url = (req?.raw?.url || req?.url || '') as string;
    const isCanonical =
      url.includes('/v1/workspaces/') || url.includes('/api/v1/workspaces/');
    const isLegacyLibraryRoute =
      url.includes('/api/library/') ||
      url.includes('/library/papers') ||
      url.includes('/library/collections') ||
      url.includes('/library/references') ||
      url.includes('/library/duplicates') ||
      url.includes('/library/integrity') ||
      url.includes('/library/sync');

    if (isLegacyLibraryRoute && !isCanonical) {
      if (typeof res?.header === 'function') {
        res.header('Deprecation', '@1756209600');
        res.header('Sunset', 'Wed, 26 Aug 2026 00:00:00 GMT');
      } else if (typeof res?.setHeader === 'function') {
        res.setHeader('Deprecation', '@1756209600');
        res.setHeader('Sunset', 'Wed, 26 Aug 2026 00:00:00 GMT');
      }
    }

    return next.handle();
  }
}
