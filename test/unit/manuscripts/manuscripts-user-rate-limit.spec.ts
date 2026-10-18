import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { RateLimitConfigService } from '@/core/http/rate-limit/rate-limit.config';
import { UserRateLimitGuard } from '@/core/http/rate-limit/user-rate-limit.guard';
import { USER_RATE_LIMIT_KEY } from '@/core/http/rate-limit/user-rate-limit.decorator';

describe('Per-User Rate Limiting (SEC-24 / US7)', () => {
  let guard: UserRateLimitGuard;
  let reflector: Reflector;
  let configService: RateLimitConfigService;
  let mockNestConfig: any;
  let mockRedisService: any;

  const userA = { id: 'user-aaa-111' };
  const userB = { id: 'user-bbb-222' };
  const sharedIp = '192.168.1.50';

  beforeEach(() => {
    reflector = new Reflector();
    mockNestConfig = {
      get: jest.fn((key: string) => {
        if (key === 'RATE_LIMIT_ENABLED') return 'true';
        if (key === 'RATE_LIMIT_COMPILE_LIMIT') return 2; // small limit for testing
        if (key === 'RATE_LIMIT_COMPILE_WINDOW') return 60;
        return undefined;
      }),
    };

    configService = new RateLimitConfigService(mockNestConfig as ConfigService);

    mockRedisService = {
      isReady: jest.fn().mockReturnValue(false),
      getClient: jest.fn().mockReturnValue(null),
    };

    guard = new UserRateLimitGuard(reflector, configService, mockRedisService);
  });

  function createMockContext(
    user?: any,
    ip = sharedIp,
    metadata = { bucket: 'compile' },
  ): ExecutionContext {
    const headers: Record<string, string> = {};
    const req = {
      user,
      ip,
      headers,
    };
    const res = {
      header: jest.fn((k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      }),
      setHeader: jest.fn((k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      }),
    };

    const handler = () => {};
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(metadata);

    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
      getHandler: () => handler,
      getClass: () => class TestController {},
    } as unknown as ExecutionContext;
  }

  describe('In-Memory Fallback & User Isolation', () => {
    it('should allow requests within the rate limit budget', async () => {
      const ctx1 = createMockContext(userA);
      const ctx2 = createMockContext(userA);

      expect(await guard.canActivate(ctx1)).toBe(true);
      expect(await guard.canActivate(ctx2)).toBe(true);
    });

    it('should throw 429 RATE_LIMITED with Retry-After header when budget is exceeded', async () => {
      const ctx1 = createMockContext(userA);
      const ctx2 = createMockContext(userA);
      const ctx3 = createMockContext(userA);

      await guard.canActivate(ctx1);
      await guard.canActivate(ctx2);

      await expect(guard.canActivate(ctx3)).rejects.toThrow(HttpException);

      try {
        await guard.canActivate(ctx3);
      } catch (err: any) {
        expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect(err.getResponse()).toMatchObject({
          statusCode: 429,
          code: 'RATE_LIMITED',
          message: 'Rate limit exceeded. Try again later.',
        });
        const res = ctx3.switchToHttp().getResponse();
        expect(res.header).toHaveBeenCalledWith(
          'Retry-After',
          expect.any(String),
        );
      }
    });

    it('SC-006: User B on the same IP must NOT be blocked when User A is rate limited', async () => {
      const ctxA1 = createMockContext(userA, sharedIp);
      const ctxA2 = createMockContext(userA, sharedIp);
      const ctxA3 = createMockContext(userA, sharedIp);
      const ctxB1 = createMockContext(userB, sharedIp);

      await guard.canActivate(ctxA1);
      await guard.canActivate(ctxA2);

      // User A is now rate-limited
      await expect(guard.canActivate(ctxA3)).rejects.toThrow(HttpException);

      // User B behind the same IP is unaffected
      expect(await guard.canActivate(ctxB1)).toBe(true);
    });

    it('should pass through routes without rate limit decorator', async () => {
      const ctx = createMockContext(userA, sharedIp, undefined);
      expect(await guard.canActivate(ctx)).toBe(true);
    });

    it('should bypass enforcement when RATE_LIMIT_ENABLED is false', async () => {
      mockNestConfig.get.mockImplementation((key: string) => {
        if (key === 'RATE_LIMIT_ENABLED') return 'false';
        if (key === 'RATE_LIMIT_COMPILE_LIMIT') return 1;
        return undefined;
      });

      const ctx1 = createMockContext(userA);
      const ctx2 = createMockContext(userA);
      const ctx3 = createMockContext(userA);

      expect(await guard.canActivate(ctx1)).toBe(true);
      expect(await guard.canActivate(ctx2)).toBe(true);
      expect(await guard.canActivate(ctx3)).toBe(true);
    });
  });

  describe('Redis Fixed Window Integration', () => {
    it('should use Redis multi pipeline when Redis is connected', async () => {
      const mockMulti = {
        incr: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          [null, 1], // INCR result: 1
          [null, 1], // EXPIRE result: 1
        ]),
      };

      const mockRedisClient = {
        multi: jest.fn().mockReturnValue(mockMulti),
      };

      mockRedisService.isReady.mockReturnValue(true);
      mockRedisService.getClient.mockReturnValue(mockRedisClient);

      const ctx = createMockContext(userA);
      const allowed = await guard.canActivate(ctx);

      expect(allowed).toBe(true);
      expect(mockRedisClient.multi).toHaveBeenCalled();
      expect(mockMulti.incr).toHaveBeenCalledWith(
        expect.stringContaining('ratelimit:compile:user-aaa-111'),
      );
      expect(mockMulti.expire).toHaveBeenCalled();
    });

    it('should throw 429 when Redis returns count exceeding limit', async () => {
      const mockMulti = {
        incr: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          [null, 5], // INCR result: 5 > limit (2)
          [null, 1],
        ]),
      };

      const mockRedisClient = {
        multi: jest.fn().mockReturnValue(mockMulti),
      };

      mockRedisService.isReady.mockReturnValue(true);
      mockRedisService.getClient.mockReturnValue(mockRedisClient);

      const ctx = createMockContext(userA);
      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    });
  });
});
