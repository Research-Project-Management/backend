import {
  Injectable,
  Logger,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import * as crypto from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';

import { getErrorMessage } from '../../utils/error.util';
import {
  applyTtlJitter,
  closeRedisClient,
  createRedisClient,
  isRedisDisabled,
  resolveLaneRedisUrl,
} from './client.factory';
import { BoundedMemoryStore } from './memory.store';
import { RedisPubSubService } from './pubsub.service';

const L1_INVALIDATION_CHANNEL = 'flux:cache:l1-inv';

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  private redisClient: Redis | null = null;
  private isConnected = false;
  private readonly instanceId = crypto.randomUUID();
  private unsubscribeL1Inv: (() => Promise<void>) | null = null;
  private readonly memoryStore = new BoundedMemoryStore(5000);
  /**
   * Single-flight request coalescing map.
   * Deduplicates concurrent database queries for identical cache keys during cache misses.
   */
  private readonly inFlightPromises = new Map<string, Promise<unknown>>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private singleflightCoalesced = 0;
  private readonly logger = new Logger(RedisCacheService.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly pubSub?: RedisPubSubService,
  ) {}

  onModuleInit() {
    if (isRedisDisabled()) {
      this.isConnected = false;
      return;
    }

    const resolvedRedisUrl = resolveLaneRedisUrl(this.configService, 'cache');

    try {
      this.redisClient = createRedisClient(resolvedRedisUrl, {
        label: 'Cache',
        logger: this.logger,
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

      if (this.pubSub) {
        void this.pubSub
          .subscribe(L1_INVALIDATION_CHANNEL, (_ch, raw) => {
            try {
              const msg = JSON.parse(raw) as {
                origin?: string;
                key?: string;
                pattern?: string;
              };
              if (msg.origin === this.instanceId) return;
              if (msg.key) {
                this.memoryStore.delete(msg.key);
              } else if (msg.pattern) {
                const rx = this.patternToRegex(msg.pattern);
                this.memoryStore.deleteMatching((k) => rx.test(k));
              }
            } catch {
              // Ignore malformed invalidation frames
            }
          })
          .then((unsub) => {
            this.unsubscribeL1Inv = unsub;
          })
          .catch(() => undefined);
      }
    } catch (err: unknown) {
      this.logger.warn(`Redis initialization warning: ${getErrorMessage(err)}`);
    }
  }

  async onModuleDestroy() {
    if (this.unsubscribeL1Inv) {
      await this.unsubscribeL1Inv().catch(() => undefined);
      this.unsubscribeL1Inv = null;
    }
    await closeRedisClient(this.redisClient);
    this.redisClient = null;
    this.isConnected = false;
    this.inFlightPromises.clear();
  }

  getClient(): Redis | null {
    return this.redisClient;
  }

  isReady(): boolean {
    return this.isConnected && this.redisClient !== null;
  }

  getStats(): {
    connected: boolean;
    hits: number;
    misses: number;
    coalesced: number;
    hitRate: number;
    memoryKeys: number;
    memoryBytes: number;
  } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      connected: this.isReady(),
      hits: this.cacheHits,
      misses: this.cacheMisses,
      coalesced: this.singleflightCoalesced,
      hitRate: total > 0 ? Number((this.cacheHits / total).toFixed(4)) : 0,
      memoryKeys: this.memoryStore.size,
      memoryBytes: this.memoryStore.calculatedSizeBytes,
    };
  }

  async get<T>(key: string): Promise<T | null> {
    // 1. Instant in-memory cache lookup (0ms latency)
    const rawCached = this.memoryStore.get(key);
    if (rawCached !== null) {
      try {
        const parsed = JSON.parse(rawCached) as T;
        if (parsed !== null) {
          this.cacheHits++;
        } else {
          this.cacheMisses++;
        }
        return parsed;
      } catch {
        this.memoryStore.delete(key);
      }
    }

    // 2. Remote Redis lookup if available
    if (this.isReady() && this.redisClient) {
      try {
        const data = await this.redisClient.get(key);
        if (data !== null) {
          this.cacheHits++;
          // Cache in memory for subsequent sub-millisecond reads with bounded TTL (60s)
          this.memoryStore.set(key, data, 60);
          return JSON.parse(data) as T;
        }
        this.cacheMisses++;
        // Cache negative lookup (key does not exist) briefly (15s) to prevent repeated Redis round-trips on hot paths (e.g., AuthGuard revocation checks)
        this.memoryStore.set(key, 'null', 15);
        return null;
      } catch (err: unknown) {
        this.cacheMisses++;
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
    this.memoryStore.set(key, serialized, ttlSeconds);

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

  async getBuffer(key: string): Promise<Buffer | null> {
    if (this.isReady() && this.redisClient) {
      try {
        return await this.redisClient.getBuffer(key);
      } catch (err: unknown) {
        this.logger.warn(
          `Cache getBuffer failed for key "${key}": ${getErrorMessage(err)}`,
        );
      }
    }
    return null;
  }

  async setBuffer(
    key: string,
    value: Buffer,
    ttlSeconds?: number,
  ): Promise<void> {
    if (!this.isReady() || !this.redisClient) return;
    try {
      if (ttlSeconds && ttlSeconds > 0) {
        await this.redisClient.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.redisClient.set(key, value);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Cache setBuffer failed for key "${key}": ${getErrorMessage(err)}`,
      );
    }
  }

  async exists(key: string): Promise<boolean> {
    if (this.memoryStore.hasValid(key)) return true;
    if (!this.isReady() || !this.redisClient) return false;
    try {
      const res = await this.redisClient.exists(key);
      return res > 0;
    } catch {
      return false;
    }
  }

  async setNx(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<boolean> {
    const serialized = JSON.stringify(value);
    if (!this.isReady() || !this.redisClient) {
      if (this.memoryStore.hasValid(key)) return false;
      this.memoryStore.set(key, serialized, ttlSeconds);
      return true;
    }
    try {
      const res =
        ttlSeconds && ttlSeconds > 0
          ? await this.redisClient.set(key, value, 'EX', ttlSeconds, 'NX')
          : await this.redisClient.set(key, value, 'NX');
      if (res === 'OK') {
        this.memoryStore.set(key, serialized, ttlSeconds);
        return true;
      }
      return false;
    } catch (err: unknown) {
      this.logger.warn(
        `SETNX failed for key "${key}": ${getErrorMessage(err)}`,
      );
      return false;
    }
  }

  async incr(key: string): Promise<number> {
    if (!this.isReady() || !this.redisClient) {
      const currentRaw = this.memoryStore.get(key);
      const next = (Number(currentRaw) || 0) + 1;
      this.memoryStore.set(key, next.toString());
      return next;
    }
    try {
      const next = await this.redisClient.incr(key);
      this.memoryStore.set(key, next.toString());
      return next;
    } catch (err: unknown) {
      this.logger.warn(`INCR failed for key "${key}": ${getErrorMessage(err)}`);
      return 0;
    }
  }

  async del(key: string): Promise<void> {
    this.memoryStore.delete(key);
    this.broadcastL1Invalidation({ key });
    if (!this.isReady() || !this.redisClient) return;
    try {
      await this.redisClient.unlink(key);
    } catch (err: unknown) {
      this.logger.warn(
        `Cache del failed for key "${key}": ${getErrorMessage(err)}`,
      );
    }
  }

  /**
   * Retrieves the remaining time to live (in seconds) of a key.
   * Returns -2 if the key does not exist, -1 if the key exists but has no associated expire.
   */
  async ttl(key: string): Promise<number> {
    if (!this.isReady() || !this.redisClient) {
      return this.memoryStore.getRemainingTtlSeconds(key);
    }
    try {
      return await this.redisClient.ttl(key);
    } catch (err: unknown) {
      this.logger.warn(
        `TTL check failed for key "${key}": ${getErrorMessage(err)}`,
      );
      return -1;
    }
  }

  private patternToRegex(pattern: string): RegExp {
    return new RegExp(
      '^' +
        pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*') +
        '$',
    );
  }

  private broadcastL1Invalidation(payload: {
    key?: string;
    pattern?: string;
  }): void {
    if (!this.pubSub?.isReady()) return;
    void this.pubSub
      .publish(
        L1_INVALIDATION_CHANNEL,
        JSON.stringify({ origin: this.instanceId, ...payload }),
      )
      .catch(() => undefined);
  }

  /**
   * Non-blocking streaming pattern deletion using Redis SCAN + UNLINK.
   * Processes batches incrementally with backpressure (pause/resume) to keep RAM O(1).
   */
  async delPattern(pattern: string): Promise<void> {
    const regexPattern = this.patternToRegex(pattern);
    this.memoryStore.deleteMatching((k) => regexPattern.test(k));
    this.broadcastL1Invalidation({ pattern });

    if (!this.isReady() || !this.redisClient) return;
    const client = this.redisClient;
    try {
      const stream = client.scanStream({
        match: pattern,
        count: 100,
      });

      await new Promise<void>((resolve) => {
        stream.on('data', (resultKeys: string[]) => {
          if (!resultKeys || resultKeys.length === 0) return;
          stream.pause();
          void (async () => {
            try {
              for (let i = 0; i < resultKeys.length; i += 100) {
                const batch = resultKeys.slice(i, i + 100);
                await client.unlink(...batch);
              }
            } catch (delErr) {
              this.logger.warn(
                `Batch cache unlink failed: ${getErrorMessage(delErr)}`,
              );
            } finally {
              stream.resume();
            }
          })();
        });

        stream.on('end', () => resolve());

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
   * Cache-aside execution with single-flight request coalescing.
   * Prevents cache stampede / thundering herd when multiple concurrent requests hit a cache miss.
   * Exactly one execution occurs for fallbackFn(), while subsequent callers await the same in-flight Promise.
   */
  async wrap<T>(
    key: string,
    fallbackFn: () => Promise<T>,
    ttlSeconds: number = 300,
  ): Promise<T> {
    // Single-Flight: Check if another request is already fetching this key synchronously
    const existingInFlight = this.inFlightPromises.get(key);
    if (existingInFlight) {
      this.singleflightCoalesced++;
      return existingInFlight as Promise<T>;
    }

    const fetchPromise = (async () => {
      try {
        const cached = await this.get<T>(key);
        if (cached !== null && cached !== undefined) {
          return cached;
        }

        const fresh = await fallbackFn();
        if (fresh !== null && fresh !== undefined) {
          await this.set(key, fresh, applyTtlJitter(ttlSeconds));
        }
        return fresh;
      } finally {
        this.inFlightPromises.delete(key);
      }
    })();

    this.inFlightPromises.set(key, fetchPromise);
    return fetchPromise;
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
   * Returns a subset of Redis `INFO stats` key-value pairs for health/observability endpoints.
   */
  async getServerInfoStats(
    maxLines = 8,
  ): Promise<Record<string, string> | null> {
    if (!this.isReady() || !this.redisClient) return null;
    try {
      const rawInfo = await this.redisClient.info('stats');
      const lines = rawInfo
        .split('\r\n')
        .filter((l) => l && !l.startsWith('#'));
      const parsed: Record<string, string> = {};
      for (const line of lines.slice(0, maxLines)) {
        const [k, v] = line.split(':');
        if (k && v) parsed[k] = v;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * EXPIRE key seconds — set TTL on any key type.
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
}
