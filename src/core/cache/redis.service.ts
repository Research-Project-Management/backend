import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { getErrorMessage } from '../utils/error.util';

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  private redisClient: Redis | null = null;
  private isConnected = false;
  private static readonly MAX_MEMORY_CACHE_SIZE = 5000;
  private memoryCache = new Map<
    string,
    { value: string; expiresAt?: number }
  >();
  private readonly logger = new Logger(RedisCacheService.name);

  private setMemoryCache(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): void {
    if (this.memoryCache.size >= RedisCacheService.MAX_MEMORY_CACHE_SIZE) {
      const now = Date.now();
      for (const [k, v] of this.memoryCache.entries()) {
        if (v.expiresAt && v.expiresAt < now) {
          this.memoryCache.delete(k);
        }
      }
      while (
        this.memoryCache.size >= RedisCacheService.MAX_MEMORY_CACHE_SIZE
      ) {
        const oldestKey = this.memoryCache.keys().next().value;
        if (!oldestKey) break;
        this.memoryCache.delete(oldestKey);
      }
    }

    const defaultTtl = ttlSeconds && ttlSeconds > 0 ? ttlSeconds : 300;
    this.memoryCache.set(key, {
      value,
      expiresAt: Date.now() + defaultTtl * 1000,
    });
  }

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_REDIS === 'true'
    ) {
      this.isConnected = false;
      return;
    }

    const redisUrl =
      this.configService.get<string>('REDIS_CACHE_URL') ||
      this.configService.get<string>('REDIS_URL') ||
      process.env.REDIS_CACHE_URL ||
      process.env.REDIS_URL ||
      'redis://localhost:6379';

    try {
      this.redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          // Bounded backoff: stop retrying after 3 attempts to prevent infinite reconnect loop
          if (times > 3) {
            this.logger.warn(
              'Redis connection could not be established after 3 attempts. Operating in memory-cache fallback mode.',
            );
            return null;
          }
          return Math.min(times * 500, 2000);
        },
        lazyConnect: true,
        enableOfflineQueue: false,
      });

      this.redisClient.on('connect', () => {
        this.isConnected = true;
        this.logger.log('Redis Cache connection established');
      });

      this.redisClient.on('ready', () => {
        this.isConnected = true;
      });

      this.redisClient.on('close', () => {
        this.isConnected = false;
      });

      this.redisClient.on('error', (err: Error) => {
        this.isConnected = false;
        if (
          err.message.includes('WRONGPASS') ||
          err.message.includes('NOAUTH')
        ) {
          this.logger.warn(
            `Redis authentication failed (${err.message}). Bypassing Redis and falling back to memory cache.`,
          );
          try {
            this.redisClient?.disconnect(false);
          } catch {
            // Ignore disconnect error
          }
          return;
        }
        // Non-blocking warning: Cache falls back to database gracefully
        this.logger.warn(`Redis Cache unavailable (bypassed): ${err.message}`);
      });

      this.redisClient.connect().catch((err: unknown) => {
        this.logger.warn(
          `Initial Redis connection deferred: ${getErrorMessage(err)}`,
        );
      });
    } catch (err: unknown) {
      this.logger.warn(`Redis initialization warning: ${getErrorMessage(err)}`);
    }
  }

  async onModuleDestroy() {
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {
        try {
          this.redisClient.disconnect();
        } catch {
          // ignore
        }
      }
      this.redisClient = null;
      this.isConnected = false;
    }
  }

  getClient(): Redis | null {
    return this.redisClient;
  }

  isReady(): boolean {
    return this.isConnected && this.redisClient !== null;
  }

  async get<T>(key: string): Promise<T | null> {
    // 1. Instant in-memory cache lookup (0ms latency)
    const item = this.memoryCache.get(key);
    if (item) {
      if (item.expiresAt && item.expiresAt < Date.now()) {
        this.memoryCache.delete(key);
      } else {
        try {
          return JSON.parse(item.value) as T;
        } catch {
          this.memoryCache.delete(key);
        }
      }
    }

    // 2. Remote Redis lookup if available
    if (this.isReady() && this.redisClient) {
      try {
        const data = await this.redisClient.get(key);
        if (data) {
          // Cache in memory for subsequent sub-millisecond reads with bounded TTL (60s)
          this.setMemoryCache(key, data, 60);
          return JSON.parse(data) as T;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Cache get failed for key "${key}": ${getErrorMessage(err)}`,
        );
      }
    }

    return null;
  }

  async set<T>(key: string, value: T, ttlSeconds: number = 300): Promise<void> {
    const serialized = JSON.stringify(value);

    // Always maintain in-memory fallback
    this.setMemoryCache(key, serialized, ttlSeconds);

    if (!this.isReady() || !this.redisClient) return;
    try {
      if (ttlSeconds > 0) {
        await this.redisClient.set(key, serialized, 'EX', ttlSeconds);
      } else {
        await this.redisClient.set(key, serialized);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Cache set failed for key "${key}": ${getErrorMessage(err)}`,
      );
    }
  }

  async del(key: string): Promise<void> {
    this.memoryCache.delete(key);
    if (!this.isReady() || !this.redisClient) return;
    try {
      await this.redisClient.del(key);
    } catch (err: unknown) {
      this.logger.warn(
        `Cache del failed for key "${key}": ${getErrorMessage(err)}`,
      );
    }
  }

  /**
   * Non-blocking pattern deletion using Redis SCAN stream to prevent event-loop blocking.
   */
  async delPattern(pattern: string): Promise<void> {
    // Delete in-memory keys matching pattern
    const regexPattern = new RegExp(
      '^' +
        pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*') +
        '$',
    );
    for (const k of this.memoryCache.keys()) {
      if (regexPattern.test(k)) {
        this.memoryCache.delete(k);
      }
    }

    if (!this.isReady() || !this.redisClient) return;
    try {
      const stream = this.redisClient.scanStream({
        match: pattern,
        count: 100,
      });

      const keysToDelete: string[] = [];
      stream.on('data', (resultKeys: string[]) => {
        if (resultKeys && resultKeys.length > 0) {
          keysToDelete.push(...resultKeys);
        }
      });

      await new Promise<void>((resolve) => {
        stream.on('end', () => {
          void (async () => {
            if (keysToDelete.length > 0 && this.redisClient) {
              try {
                // Delete in batches of 100 keys
                for (let i = 0; i < keysToDelete.length; i += 100) {
                  const batch = keysToDelete.slice(i, i + 100);
                  await this.redisClient.del(...batch);
                }
              } catch (delErr) {
                this.logger.warn(
                  `Batch cache del failed: ${getErrorMessage(delErr)}`,
                );
              }
            }
            resolve();
          })();
        });

        stream.on('error', (err) => {
          this.logger.warn(
            `Cache SCAN stream warning for "${pattern}": ${getErrorMessage(err)}`,
          );
          resolve();
        });
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Cache delPattern failed for "${pattern}": ${getErrorMessage(err)}`,
      );
    }
  }

  /**
   * Cache-Aside Pattern: Retrieve from cache if present, otherwise fetch from fallback function and cache it.
   */
  async wrap<T>(
    key: string,
    fallbackFn: () => Promise<T>,
    ttlSeconds: number = 300,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null && cached !== undefined) {
      return cached;
    }

    const fresh = await fallbackFn();
    if (fresh !== null && fresh !== undefined) {
      await this.set(key, fresh, ttlSeconds);
    }
    return fresh;
  }

  /**
   * Helper to build standardized cache keys
   */
  buildKey(
    domain: string,
    ...segments: (string | number | undefined)[]
  ): string {
    const validSegments = segments.filter(
      (s) => s !== undefined && s !== null && s !== '',
    );
    return [domain, ...validSegments].join(':');
  }

  /**
   * Invalidate all keys matching an arbitrary entity/scope ID
   */
  async invalidateScope(scopeId: string): Promise<void> {
    if (!scopeId) return;
    await this.delPattern(`*${scopeId}*`);
  }

  /**
   * Invalidate all keys matching a project scope
   */
  async invalidateProject(projectId: string): Promise<void> {
    if (!projectId) return;
    await this.delPattern(`*${projectId}*`);
  }

  /**
   * Invalidate all keys matching a user scope
   */
  async invalidateUser(userId: string): Promise<void> {
    if (!userId) return;
    await this.delPattern(`*${userId}*`);
  }

  /**
   * Invalidate a single entity key
   */
  async invalidateEntity(entityType: string, entityId: string): Promise<void> {
    if (!entityType || !entityId) return;
    await this.del(`${entityType}:${entityId}`);
    await this.delPattern(`${entityType}:${entityId}:*`);
  }

  // ─── Sorted Set Operations (for op logs, leaderboards, time-series) ──────────

  /**
   * ZADD key score member — add a member with a score to a sorted set.
   * Returns the number of elements added.
   */
  async zadd(key: string, score: number, member: string): Promise<number> {
    if (!this.isReady() || !this.redisClient) return 0;
    try {
      return await this.redisClient.zadd(key, score, member);
    } catch (err: unknown) {
      this.logger.debug(
        `ZADD failed for key "${key}": ${getErrorMessage(err)}`,
      );
      return 0;
    }
  }

  /**
   * ZRANGEBYSCORE key min max [WITHSCORES] — returns members with scores between min and max.
   */
  async zrangebyscore(
    key: string,
    min: number | '-inf',
    max: number | '+inf',
  ): Promise<Array<{ member: string; score: number }>> {
    if (!this.isReady() || !this.redisClient) return [];
    try {
      const raw = await this.redisClient.zrangebyscore(
        key,
        min,
        max,
        'WITHSCORES',
      );
      const results: Array<{ member: string; score: number }> = [];
      for (let i = 0; i < raw.length; i += 2) {
        results.push({ member: raw[i], score: Number(raw[i + 1]) });
      }
      return results;
    } catch (err: unknown) {
      this.logger.debug(
        `ZRANGEBYSCORE failed for key "${key}": ${getErrorMessage(err)}`,
      );
      return [];
    }
  }

  /**
   * ZREMRANGEBYRANK key start stop — removes members with rank between start and stop.
   * Use to cap sorted set size (e.g., keep only latest N ops).
   */
  async zremrangebyrank(
    key: string,
    start: number,
    stop: number,
  ): Promise<number> {
    if (!this.isReady() || !this.redisClient) return 0;
    try {
      return await this.redisClient.zremrangebyrank(key, start, stop);
    } catch (err: unknown) {
      this.logger.debug(
        `ZREMRANGEBYRANK failed for key "${key}": ${getErrorMessage(err)}`,
      );
      return 0;
    }
  }

  /**
   * ZREMRANGEBYSCORE key min max — removes members with score between min and max.
   * Used for oplog compaction after snapshot creation.
   */
  async zremrangebyscore(
    key: string,
    min: number | '-inf',
    max: number | '+inf',
  ): Promise<number> {
    if (!this.isReady() || !this.redisClient) return 0;
    try {
      return await this.redisClient.zremrangebyscore(key, min, max);
    } catch (err: unknown) {
      this.logger.debug(
        `ZREMRANGEBYSCORE failed for key "${key}": ${getErrorMessage(err)}`,
      );
      return 0;
    }
  }

  /**
   * EXPIRE key seconds — set TTL on any key type (including sorted sets).
   */
  async expire(key: string, seconds: number): Promise<void> {
    if (!this.isReady() || !this.redisClient) return;
    try {
      await this.redisClient.expire(key, seconds);
    } catch (err: unknown) {
      this.logger.debug(
        `EXPIRE failed for key "${key}": ${getErrorMessage(err)}`,
      );
    }
  }

  /**
   * ZCARD key — returns the number of members in the sorted set.
   */
  async zcard(key: string): Promise<number> {
    if (!this.isReady() || !this.redisClient) return 0;
    try {
      return await this.redisClient.zcard(key);
    } catch (err: unknown) {
      this.logger.debug(
        `ZCARD failed for key "${key}": ${getErrorMessage(err)}`,
      );
      return 0;
    }
  }
}

export const RedisService = RedisCacheService;
