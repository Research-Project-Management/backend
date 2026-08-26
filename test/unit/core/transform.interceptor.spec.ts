import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { TransformInterceptor } from '@/core/interceptors/transform.interceptor';

describe('TransformInterceptor', () => {
  let interceptor: TransformInterceptor<any>;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    interceptor = new TransformInterceptor(reflector);
  });

  function createMockContext(bypassed = false): ExecutionContext {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getResponse: () => ({
          sent: false,
          raw: { headersSent: false },
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it('should wrap successful plain data in envelope', (done) => {
    const context = createMockContext();
    const handler: CallHandler = {
      handle: () => of({ message: 'hello', id: '123' }),
    };

    interceptor.intercept(context, handler).subscribe((result: any) => {
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ message: 'hello', id: '123' });
      expect(result.timestamp).toBeDefined();
      done();
    });
  });

  it('should wrap paginated result correctly', (done) => {
    const context = createMockContext();
    const paginated = {
      items: ['item1', 'item2'],
      pagination: {
        page: 1,
        pageSize: 20,
        totalItems: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
      },
    };
    const handler: CallHandler = {
      handle: () => of(paginated),
    };

    interceptor.intercept(context, handler).subscribe((result) => {
      expect(result.success).toBe(true);
      expect(result.data).toEqual(['item1', 'item2']);
      expect(result.pagination).toEqual({
        page: 1,
        pageSize: 20,
        totalItems: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
      });
      done();
    });
  });

  it('should bypass enveloping when @BypassEnvelope() is set', (done) => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const context = createMockContext(true);
    const handler: CallHandler = {
      handle: () => of('raw sse stream data'),
    };

    interceptor.intercept(context, handler).subscribe((result) => {
      expect(result).toBe('raw sse stream data');
      expect(result.success).toBeUndefined();
      done();
    });
  });
});
