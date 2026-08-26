import { IdempotencyInterceptor } from '@/core/idempotency/idempotency.interceptor';
import { ExecutionContext, ConflictException } from '@nestjs/common';
import { of } from 'rxjs';

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;

  beforeEach(() => {
    interceptor = new IdempotencyInterceptor();
    IdempotencyInterceptor.clearCacheForTesting();
  });

  const createMockContext = (
    method: string,
    headers: Record<string, string>,
    userId = 'user-1',
  ): { context: ExecutionContext; mockReply: any } => {
    const mockReply = {
      statusCode: 201,
      header: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    const mockRequest = {
      method,
      headers,
      user: { id: userId },
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => mockReply,
      }),
    } as unknown as ExecutionContext;

    return { context, mockReply };
  };

  it('passes through GET requests without idempotency caching', (done) => {
    const { context } = createMockContext('GET', {
      'idempotency-key': 'key-123',
    });
    const next = { handle: () => of({ result: 'ok' }) };

    interceptor.intercept(context, next).subscribe((res: any) => {
      expect(res).toEqual({ result: 'ok' });
      done();
    });
  });

  it('records and caches response for a new POST mutation with Idempotency-Key', (done) => {
    const { context } = createMockContext('POST', {
      'idempotency-key': 'tx-abc-123',
    });
    const next = {
      handle: () => of({ id: 'item-created', title: 'New Item' }),
    };

    interceptor.intercept(context, next).subscribe((res: any) => {
      expect(res).toEqual({ id: 'item-created', title: 'New Item' });

      // Second call with same idempotency-key should replay cached response
      const { context: context2, mockReply: mockReply2 } = createMockContext(
        'POST',
        { 'idempotency-key': 'tx-abc-123' },
      );
      const next2 = { handle: jest.fn() };

      interceptor.intercept(context2, next2).subscribe((replayedRes: any) => {
        expect(replayedRes).toEqual({
          id: 'item-created',
          title: 'New Item',
        });
        expect(mockReply2.header).toHaveBeenCalledWith(
          'Idempotent-Replay',
          'true',
        );
        expect(next2.handle).not.toHaveBeenCalled();
        done();
      });
    });
  });

  it('throws ConflictException if another mutation with same key is currently in progress', () => {
    const { context } = createMockContext('POST', {
      'idempotency-key': 'in-progress-tx',
    });
    const next = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, next);

    expect(() => {
      interceptor.intercept(context, next);
    }).toThrow(ConflictException);
  });
});
