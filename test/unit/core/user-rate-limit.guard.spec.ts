import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRateLimitGuard } from '../../../src/core/http/rate-limit/user-rate-limit.guard';
import { RateLimitConfigService } from '../../../src/core/http/rate-limit/rate-limit.config';
import { USER_RATE_LIMIT_KEY, UserRateLimitRule } from '../../../src/core/http/rate-limit/user-rate-limit.decorator';

describe('UserRateLimitGuard - Sliding Window Counter Engine', () => {
  let guard: UserRateLimitGuard;
  let reflector: jest.Mocked<Reflector>;
  let configService: jest.Mocked<RateLimitConfigService>;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;

    configService = {
      isEnabled: jest.fn().mockReturnValue(true),
      getBudget: jest.fn().mockImplementation((bucket: string) => {
        if (bucket === 'auth-login-target') {
          return { limit: 5, windowSeconds: 60 };
        }
        if (bucket === 'auth-login-ip') {
          return { limit: 30, windowSeconds: 60 };
        }
        return { limit: 10, windowSeconds: 60 };
      }),
    } as any;

    guard = new UserRateLimitGuard(reflector, configService);
    guard.resetMemoryBuckets();
  });

  const createMockContext = (req: any, res: any = {}): ExecutionContext => {
    const headers: Record<string, string> = {};
    res.header = jest.fn((k: string, v: string) => {
      headers[k] = v;
    });
    res.setHeader = jest.fn((k: string, v: string) => {
      headers[k] = v;
    });

    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as any;
  };

  it('bypasses guard when rate limiting is globally disabled', async () => {
    configService.isEnabled.mockReturnValue(false);
    const ctx = createMockContext({});

    const allowed = await guard.canActivate(ctx);
    expect(allowed).toBe(true);
  });

  it('bypasses guard when route has no rate limit decorator', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const ctx = createMockContext({});

    const allowed = await guard.canActivate(ctx);
    expect(allowed).toBe(true);
  });

  it('allows requests within budget and sets proper X-RateLimit headers', async () => {
    const rules: UserRateLimitRule[] = [
      { bucket: 'auth-login-target', limit: 3, windowSeconds: 60, keyType: 'email' },
    ];
    reflector.getAllAndOverride.mockReturnValue(rules);

    const req = { body: { email: 'researcher@flux.ai' }, ip: '192.168.1.1' };
    const res: any = {};
    const ctx = createMockContext(req, res);

    // Request 1: Allowed (1/3)
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(res.header).toHaveBeenCalledWith('X-RateLimit-Limit', '3');
    expect(res.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '2');

    // Request 2: Allowed (2/3)
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(res.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '1');

    // Request 3: Allowed (3/3)
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(res.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
  });

  it('throws 429 Too Many Requests when budget is exceeded and provides Retry-After', async () => {
    const rules: UserRateLimitRule[] = [
      { bucket: 'auth-login-target', limit: 2, windowSeconds: 60, keyType: 'email' },
    ];
    reflector.getAllAndOverride.mockReturnValue(rules);

    const req = { body: { email: 'target@flux.ai' }, ip: '10.0.0.1' };
    const res: any = {};
    const ctx = createMockContext(req, res);

    await guard.canActivate(ctx); // 1
    await guard.canActivate(ctx); // 2 (at limit)

    // 3rd attempt exceeds limit
    let error: any;
    try {
      await guard.canActivate(ctx);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    const body = error.getResponse();
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(res.header).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('enforces Dual-Key throttling: blocks if either IP or Target Email exceeds limit', async () => {
    const rules: UserRateLimitRule[] = [
      { bucket: 'auth-login-ip', limit: 10, windowSeconds: 60, keyType: 'ip' },
      { bucket: 'auth-login-target', limit: 2, windowSeconds: 60, keyType: 'email' },
    ];
    reflector.getAllAndOverride.mockReturnValue(rules);

    const req = { body: { email: 'victim@flux.ai' }, ip: '123.45.67.89' };
    const res: any = {};
    const ctx = createMockContext(req, res);

    // 1st request: OK
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // 2nd request: OK
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    // 3rd request from same IP to same email: hits target limit (2) even though IP limit is 10
    await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);

    // 4th request from same IP to DIFFERENT email: passes because email limit is fresh!
    const reqDifferentUser = { body: { email: 'other@flux.ai' }, ip: '123.45.67.89' };
    const ctxDifferentUser = createMockContext(reqDifferentUser, res);
    await expect(guard.canActivate(ctxDifferentUser)).resolves.toBe(true);
  });

  it('demonstrates sliding window mathematical decay and boundary smoothing', async () => {
    // Direct test of evaluateLimit memory algorithm across simulated timestamps
    const bucket = 'test-decay';
    const actorKey = 'user:123';
    const limit = 5;
    const windowSeconds = 60;

    // Fill up 5 requests in Window 0 (t = 10,000ms)
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    for (let i = 0; i < 5; i++) {
      const res = await guard.evaluateLimit(bucket, actorKey, limit, windowSeconds);
      expect(res.allowed).toBe(true);
    }

    // 6th request at t = 10,000ms: rejected
    const blockedRes = await guard.evaluateLimit(bucket, actorKey, limit, windowSeconds);
    expect(blockedRes.allowed).toBe(false);

    // Advance to Window 1, t = 90,000ms (halfway through window 1: 30s elapsed of 60s)
    // Elapsed = 30s. Weight = 1 - 30/60 = 0.5.
    // Estimated prev contribution = floor(5 * 0.5) = 2.
    // Current count = 0. Total estimated = 2 < 5.
    // 3 slots available!
    jest.spyOn(Date, 'now').mockReturnValue(90_000);

    const midWindowRes1 = await guard.evaluateLimit(bucket, actorKey, limit, windowSeconds);
    expect(midWindowRes1.allowed).toBe(true); // 2 + 1 = 3 <= 5

    const midWindowRes2 = await guard.evaluateLimit(bucket, actorKey, limit, windowSeconds);
    expect(midWindowRes2.allowed).toBe(true); // 3 + 1 = 4 <= 5

    const midWindowRes3 = await guard.evaluateLimit(bucket, actorKey, limit, windowSeconds);
    expect(midWindowRes3.allowed).toBe(true); // 4 + 1 = 5 <= 5

    // 4th request in mid-window: hits limit (5 + 1 > 5)
    const midWindowRes4 = await guard.evaluateLimit(bucket, actorKey, limit, windowSeconds);
    expect(midWindowRes4.allowed).toBe(false);

    jest.restoreAllMocks();
  });
});
