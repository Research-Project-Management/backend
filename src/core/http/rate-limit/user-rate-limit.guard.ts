import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitConfigService } from './rate-limit.config';
import {
  USER_RATE_LIMIT_KEY,
  UserRateLimitOptions,
} from './user-rate-limit.decorator';
import { RedisCacheService } from '../../infrastructure/redis/redis.service';

interface MemoryBucketEntry {
  count: number;
  resetAt: number;
}

@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(UserRateLimitGuard.name);
  private readonly memoryBuckets = new Map<string, MemoryBucketEntry>();
  private static readonly MAX_MEMORY_ENTRIES = 10000;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: RateLimitConfigService,
    @Optional() private readonly redisService?: RedisCacheService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.configService.isEnabled()) {
      return true;
    }

    const options = this.reflector.getAllAndOverride<
      UserRateLimitOptions | undefined
    >(USER_RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);

    if (!options || !options.bucket) {
      return true;
    }

    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const user = req?.user;
    const userId =
      user?.id || user?.sub || user?.userId || req?.ip || 'anonymous';

    const budget = this.configService.getBudget(options.bucket);
    const limit =
      options.limit !== undefined && options.limit > 0
        ? options.limit
        : budget.limit;
    const windowSeconds =
      options.windowSeconds !== undefined && options.windowSeconds > 0
        ? options.windowSeconds
        : budget.windowSeconds;

    const { count, ttl } = await this.increment(
      options.bucket,
      userId,
      windowSeconds,
    );

    const retryAfter = Math.max(1, ttl);

    if (count > limit) {
      this.logger.warn(
        `Rate limit exceeded for user ${userId} on bucket '${options.bucket}' (${count}/${limit}). Retry after ${retryAfter}s`,
      );

      if (res && typeof res.header === 'function') {
        res.header('Retry-After', String(retryAfter));
        res.header('X-RateLimit-Limit', String(limit));
        res.header('X-RateLimit-Remaining', '0');
        res.header('X-RateLimit-Reset', String(retryAfter));
      } else if (res && typeof res.setHeader === 'function') {
        res.setHeader('Retry-After', String(retryAfter));
      }

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'RATE_LIMITED',
          message: 'Rate limit exceeded. Try again later.',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (res && typeof res.header === 'function') {
      res.header('X-RateLimit-Limit', String(limit));
      res.header('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
      res.header('X-RateLimit-Reset', String(retryAfter));
    }

    return true;
  }

  private async increment(
    bucket: string,
    userId: string,
    windowSeconds: number,
  ): Promise<{ count: number; ttl: number }> {
    if (this.redisService?.isReady()) {
      try {
        const client = this.redisService.getClient();
        if (client) {
          const nowSeconds = Math.floor(Date.now() / 1000);
          const windowIndex = Math.floor(nowSeconds / windowSeconds);
          const redisKey = `ratelimit:${bucket}:${userId}:${windowIndex}`;

          const multi = client.multi();
          multi.incr(redisKey);
          multi.expire(redisKey, windowSeconds * 2);
          const results = await multi.exec();

          const count = Number(results?.[0]?.[1] ?? 1);
          const ttl = Math.max(1, windowSeconds - (nowSeconds % windowSeconds));
          return { count, ttl };
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Redis rate limit increment failed, falling back to memory: ${err}`,
        );
      }
    }

    return this.incrementMemory(bucket, userId, windowSeconds);
  }

  private incrementMemory(
    bucket: string,
    userId: string,
    windowSeconds: number,
  ): { count: number; ttl: number } {
    const now = Date.now();
    const key = `${bucket}:${userId}`;
    const entry = this.memoryBuckets.get(key);

    if (this.memoryBuckets.size >= UserRateLimitGuard.MAX_MEMORY_ENTRIES) {
      for (const [k, v] of this.memoryBuckets.entries()) {
        if (v.resetAt <= now) {
          this.memoryBuckets.delete(k);
        }
      }
    }

    if (!entry || entry.resetAt <= now) {
      const resetAt = now + windowSeconds * 1000;
      this.memoryBuckets.set(key, { count: 1, resetAt });
      return { count: 1, ttl: windowSeconds };
    }

    entry.count += 1;
    const ttl = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return { count: entry.count, ttl };
  }

  public resetMemoryBuckets(): void {
    this.memoryBuckets.clear();
  }
}
