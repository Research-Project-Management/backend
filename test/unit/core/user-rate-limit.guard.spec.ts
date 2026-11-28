import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromPartial } from '@total-typescript/shoehorn';
import { RateLimitConfigService } from '@/core/http/rate-limit/rate-limit.config';
import { type UserRateLimitRule } from '@/core/http/rate-limit/user-rate-limit.decorator';
import { UserRateLimitGuard } from '@/core/http/rate-limit/user-rate-limit.guard';

describe('UserRateLimitGuard - Sliding Window Counter Engine', () => {
  let guard: UserRateLimitGuard;
  let reflector: jest.Mocked<Reflector>;
  let configService: jest.Mocked<RateLimitConfigService>;

  beforeEach(() => {
    reflector = fromPartial<jest.Mocked<Reflector>>({
      getAllAndOverride: jest.fn(),
    });

    configService = fromPartial<RateLimitConfigService>({
      isEnabled: jest.fn().mockReturnValue(true),
      getBudget: jest.fn((bucket: string) => {
        if (bucket === 'auth-login-target') {
          return { limit: 5, windowSeconds: 60 };
        }
        if (bucket === 'auth-login-ip') {
          return { limit: 30, windowSeconds: 60 };
        }
        return { limit: 10, windowSeconds: 60 };
      }),
    }) as jest.Mocked<RateLimitConfigService>;

    guard = new UserRateLimitGuard(reflector, configService);
    guard.resetMemoryBuckets();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const createMockContext = (
    req: Record<string, unknown>,
    res: { header?: jest.Mock; setHeader?: jest.Mock } = {},
  ): ExecutionContext => {
    res.header = jest.fn();
    res.setHeader = jest.fn();

    return fromPartial<ExecutionContext>({
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
      getHandler: () => (() => undefined) as never,
      getClass: () => class Dummy {} as never,
    });
  };

  it('bypasses when globally disabled or undecorated, sets X-RateLimit headers within budget, and throws 429 with Retry-After when exceeded', async () => {
    configService.isEnabled.mockReturnValueOnce(false);
    await expect(guard.canActivate(createMockContext({}))).resolves.toBe(true);

    reflector.getAllAndOverride.mockReturnValueOnce(undefined);
    await expect(guard.canActivate(createMockContext({}))).resolves.toBe(true);

    const rules: UserRateLimitRule[] = [
      {
        bucket: 'auth-login-target',
        limit: 2,
        windowSeconds: 60,
        keyType: 'email',
      },
    ];
    reflector.getAllAndOverride.mockReturnValue(rules);

    const req = { body: { email: 'researcher@flux.ai' }, ip: '192.168.1.1' };
    const res: { header?: jest.Mock; setHeader?: jest.Mock } = {};
    const ctx = createMockContext(req, res);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(res.header).toHaveBeenCalledWith('X-RateLimit-Limit', '2');
    expect(res.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '1');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(res.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');

    let error: unknown;
    try {
      await guard.canActivate(ctx);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(res.header).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('enforces dual-key IP + email throttling and sliding-window boundary smoothing', async () => {
    reflector.getAllAndOverride.mockReturnValue([
      { bucket: 'auth-login-ip', limit: 10, windowSeconds: 60, keyType: 'ip' },
      {
        bucket: 'auth-login-target',
        limit: 2,
        windowSeconds: 60,
        keyType: 'email',
      },
    ] satisfies UserRateLimitRule[]);

    const victimCtx = createMockContext({
      body: { email: 'victim@flux.ai' },
      ip: '123.45.67.89',
    });
    await expect(guard.canActivate(victimCtx)).resolves.toBe(true);
    await expect(guard.canActivate(victimCtx)).resolves.toBe(true);
    await expect(guard.canActivate(victimCtx)).rejects.toThrow(HttpException);

    // Same IP with different email still passes
    const otherCtx = createMockContext({
      body: { email: 'other@flux.ai' },
      ip: '123.45.67.89',
    });
    await expect(guard.canActivate(otherCtx)).resolves.toBe(true);

    // Sliding window mathematical decay
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    for (let i = 0; i < 5; i++) {
      expect(
        (await guard.evaluateLimit('test-decay', 'user:123', 5, 60)).allowed,
      ).toBe(true);
    }
    expect(
      (await guard.evaluateLimit('test-decay', 'user:123', 5, 60)).allowed,
    ).toBe(false);

    // Halfway into window 1 (t = 90_000ms): prev weight = 0.5 -> floor(5 * 0.5) = 2 -> 3 slots available
    jest.spyOn(Date, 'now').mockReturnValue(90_000);
    for (let i = 0; i < 3; i++) {
      expect(
        (await guard.evaluateLimit('test-decay', 'user:123', 5, 60)).allowed,
      ).toBe(true);
    }
    expect(
      (await guard.evaluateLimit('test-decay', 'user:123', 5, 60)).allowed,
    ).toBe(false);
  });
});
