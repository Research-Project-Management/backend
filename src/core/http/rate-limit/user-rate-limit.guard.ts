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
  UserRateLimitRule,
  RateLimitKeyType,
} from './user-rate-limit.decorator';
import { RedisCacheService } from '../../infrastructure/redis/redis.service';

interface MemoryRateLimitEntry {
  currentCount: number;
  prevCount: number;
  windowIndex: number;
  lastUpdated: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfter: number;
}

/**
 * Enterprise Sliding Window Counter Rate Limiter Guard.
 * 
 * Implements the Cloudflare Hybrid Sliding Window approximation algorithm:
 *   EstimatedCount = CurrentWindowCount + PrevWindowCount * (1 - ElapsedInCurrentWindow / WindowSize)
 * 
 * Guarantees:
 * 1. O(1) Memory Footprint: Only 2 integer keys in Redis (~72 bytes total per active actor).
 * 2. Complete Boundary Spike Elimination: Prevents 2x bursts at window rollover.
 * 3. Atomic Lua Execution: Evaluates limit and increments atomically inside Redis engine.
 * 4. Dual-Key Support: Allows simultaneous IP and Account / Email target throttling.
 * 5. Deterministic In-Memory Fallback: Mirrors exact Redis math during tests or connection drops.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(UserRateLimitGuard.name);
  private readonly memoryBuckets = new Map<string, MemoryRateLimitEntry>();
  private static readonly MAX_MEMORY_ENTRIES = 10000;

  /**
   * Atomic Lua script for sliding window counter rate limiting.
   * KEYS[1]: Current window counter key (ratelimit:{bucket}:{key}:{currentWindowIndex})
   * KEYS[2]: Previous window counter key (ratelimit:{bucket}:{key}:{prevWindowIndex})
   * ARGV[1]: Limit (number)
   * ARGV[2]: Window size in seconds (number)
   * ARGV[3]: Current timestamp in ms (number)
   * 
   * Returns: [allowed (1 or 0), estimated_count, retry_after_seconds]
   */
  private static readonly SLIDING_WINDOW_LUA = `
    local current_key = KEYS[1]
    local prev_key = KEYS[2]
    local limit = tonumber(ARGV[1])
    local window_seconds = tonumber(ARGV[2])
    local now_ms = tonumber(ARGV[3])

    local current_count = tonumber(redis.call('get', current_key) or '0')
    local prev_count = tonumber(redis.call('get', prev_key) or '0')

    local window_ms = window_seconds * 1000
    local window_start_ms = math.floor(now_ms / window_ms) * window_ms
    local elapsed_ms = now_ms - window_start_ms
    local weight = 1.0 - (elapsed_ms / window_ms)
    if weight < 0 then weight = 0 end

    local estimated_count = current_count + math.floor(prev_count * weight)

    if estimated_count >= limit then
      local retry_after = math.ceil((window_ms - elapsed_ms) / 1000)
      if retry_after <= 0 then retry_after = 1 end
      return {0, estimated_count, retry_after}
    end

    redis.call('incr', current_key)
    redis.call('expire', current_key, window_seconds * 2)
    return {1, estimated_count + 1, 0}
  `;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: RateLimitConfigService,
    @Optional() private readonly redisService?: RedisCacheService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.configService.isEnabled()) {
      return true;
    }

    const rules = this.reflector.getAllAndOverride<
      UserRateLimitRule[] | UserRateLimitRule | undefined
    >(USER_RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);

    if (!rules) {
      return true;
    }

    const normalizedRules: UserRateLimitRule[] = Array.isArray(rules)
      ? rules
      : [rules];

    if (normalizedRules.length === 0) {
      return true;
    }

    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    // Iterate through all rules (Dual-Key IP + Identity evaluation)
    for (const rule of normalizedRules) {
      const budget = this.configService.getBudget(rule.bucket);
      const limit =
        rule.limit !== undefined && rule.limit > 0 ? rule.limit : budget.limit;
      const windowSeconds =
        rule.windowSeconds !== undefined && rule.windowSeconds > 0
          ? rule.windowSeconds
          : budget.windowSeconds;

      const actorKey = this.extractActorKey(req, rule.keyType);

      const result = await this.evaluateLimit(
        rule.bucket,
        actorKey,
        limit,
        windowSeconds,
      );

      if (!result.allowed) {
        this.logger.warn(
          `Rate limit exceeded for actor [${actorKey}] on bucket '${rule.bucket}' (${result.count}/${limit}). Retry-After: ${result.retryAfter}s`,
        );

        this.applyHeaders(res, limit, 0, result.retryAfter);

        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            code: 'RATE_LIMITED',
            message: `Rate limit exceeded for '${rule.bucket}'. Please try again later.`,
            retryAfter: result.retryAfter,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // Propagate remaining headers on success
      this.applyHeaders(
        res,
        limit,
        Math.max(0, limit - result.count),
        result.retryAfter,
      );
    }

    return true;
  }

  /**
   * Resolves the actor identifier based on the requested key type.
   */
  private extractActorKey(
    req: any,
    keyType: RateLimitKeyType = 'user-or-ip',
  ): string {
    const forwarded = req?.headers?.['x-forwarded-for'];
    const clientIp =
      typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : req?.ip || req?.socket?.remoteAddress || '127.0.0.1';

    switch (keyType) {
      case 'ip':
        return `ip:${clientIp}`;
      case 'email': {
        const bodyEmail = req?.body?.email;
        if (typeof bodyEmail === 'string' && bodyEmail.trim()) {
          return `email:${bodyEmail.toLowerCase().trim()}`;
        }
        return `ip:${clientIp}`;
      }
      case 'user': {
        const userId = req?.user?.id || req?.user?.sub;
        return userId ? `user:${userId}` : `ip:${clientIp}`;
      }
      case 'user-or-ip':
      default: {
        const userId = req?.user?.id || req?.user?.sub;
        return userId ? `user:${userId}` : `ip:${clientIp}`;
      }
    }
  }

  /**
   * Evaluates the sliding window rate limit using Redis atomic Lua with in-memory fallback.
   */
  public async evaluateLimit(
    bucket: string,
    actorKey: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    if (this.redisService?.isReady()) {
      try {
        const client = this.redisService.getClient();
        if (client) {
          const nowMs = Date.now();
          const windowMs = windowSeconds * 1000;
          const currentWindowIndex = Math.floor(nowMs / windowMs);

          const currentKey = `ratelimit:${bucket}:${actorKey}:${currentWindowIndex}`;
          const prevKey = `ratelimit:${bucket}:${actorKey}:${currentWindowIndex - 1}`;

          const rawResult = (await client.eval(
            UserRateLimitGuard.SLIDING_WINDOW_LUA,
            2,
            currentKey,
            prevKey,
            String(limit),
            String(windowSeconds),
            String(nowMs),
          )) as [number, number, number];

          const allowed = rawResult[0] === 1;
          const count = Number(rawResult[1]);
          const retryAfter = Number(rawResult[2]);

          return { allowed, count, limit, retryAfter };
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Redis sliding window evaluation failed, falling back to memory: ${err}`,
        );
      }
    }

    return this.evaluateLimitMemory(bucket, actorKey, limit, windowSeconds);
  }

  /**
   * Deterministic In-Memory Sliding Window Counter Fallback.
   * Exactly matches the Cloudflare Hybrid formula used by the Redis Lua script.
   */
  private evaluateLimitMemory(
    bucket: string,
    actorKey: string,
    limit: number,
    windowSeconds: number,
  ): RateLimitResult {
    const nowMs = Date.now();
    const windowMs = windowSeconds * 1000;
    const currentWindowIndex = Math.floor(nowMs / windowMs);
    const key = `${bucket}:${actorKey}`;

    // Clean up stale entries periodically
    if (this.memoryBuckets.size >= UserRateLimitGuard.MAX_MEMORY_ENTRIES) {
      const expirationThreshold = nowMs - windowMs * 2;
      for (const [k, v] of this.memoryBuckets.entries()) {
        if (v.lastUpdated < expirationThreshold) {
          this.memoryBuckets.delete(k);
        }
      }
    }

    let entry = this.memoryBuckets.get(key);
    if (!entry) {
      entry = {
        currentCount: 0,
        prevCount: 0,
        windowIndex: currentWindowIndex,
        lastUpdated: nowMs,
      };
      this.memoryBuckets.set(key, entry);
    } else {
      if (entry.windowIndex === currentWindowIndex - 1) {
        entry.prevCount = entry.currentCount;
        entry.currentCount = 0;
        entry.windowIndex = currentWindowIndex;
      } else if (entry.windowIndex < currentWindowIndex - 1) {
        entry.prevCount = 0;
        entry.currentCount = 0;
        entry.windowIndex = currentWindowIndex;
      }
    }

    entry.lastUpdated = nowMs;

    const windowStartMs = currentWindowIndex * windowMs;
    const elapsedMs = nowMs - windowStartMs;
    const weight = Math.max(0, 1 - elapsedMs / windowMs);
    const estimatedCount = entry.currentCount + Math.floor(entry.prevCount * weight);

    if (estimatedCount >= limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - elapsedMs) / 1000));
      return {
        allowed: false,
        count: estimatedCount,
        limit,
        retryAfter,
      };
    }

    entry.currentCount += 1;
    return {
      allowed: true,
      count: estimatedCount + 1,
      limit,
      retryAfter: 0,
    };
  }

  private applyHeaders(
    res: any,
    limit: number,
    remaining: number,
    retryAfter: number,
  ): void {
    if (!res) return;

    const headers: Record<string, string> = {
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(remaining),
      'X-RateLimit-Reset': String(retryAfter),
    };

    if (retryAfter > 0) {
      headers['Retry-After'] = String(retryAfter);
    }

    if (typeof res.header === 'function') {
      for (const [k, v] of Object.entries(headers)) {
        res.header(k, v);
      }
    } else if (typeof res.setHeader === 'function') {
      for (const [k, v] of Object.entries(headers)) {
        res.setHeader(k, v);
      }
    }
  }

  public resetMemoryBuckets(): void {
    this.memoryBuckets.clear();
  }
}