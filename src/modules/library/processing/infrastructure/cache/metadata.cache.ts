import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisCacheService } from '@/core/cache/redis.service';
import { QueryType, ResolvedMetadata } from '../../domain/types/metadata.types';
import { METADATA_POLICY_VERSION } from '../../domain/policies/metadata.policy';

const NEGATIVE_SENTINEL = '__metadata_negative__';

interface L1CacheEntry {
  value: ResolvedMetadata | false;
  expiresAt: number;
}

@Injectable()
export class MetadataCache {
  private readonly logger = new Logger(MetadataCache.name);

  // Positive TTLs (seconds)
  private readonly TTL_MAP: Record<QueryType, number> = {
    DOI: 7 * 86_400, // 7 days
    ARXIV: 7 * 86_400, // 7 days
    PMID: 7 * 86_400, // 7 days
    ISBN: 14 * 86_400, // 14 days
    URL: 86_400, // 24 hours
    TITLE: 86_400, // 24 hours
  };

  // Negative TTLs (seconds) — short so new preprints/papers are discovered quickly
  private readonly NEGATIVE_TTL_MAP: Record<QueryType, number> = {
    DOI: 3_600, // 1 hour
    ARXIV: 3_600, // 1 hour
    PMID: 3_600, // 1 hour
    ISBN: 7_200, // 2 hours
    URL: 900, // 15 minutes
    TITLE: 900, // 15 minutes
  };

  // Tier 1: High-Performance In-Memory LRU Cache (<0.05ms latency)
  private readonly l1Cache = new Map<string, L1CacheEntry>();
  private readonly MAX_L1_ENTRIES = 1000;

  constructor(@Optional() private readonly redis?: RedisCacheService) {}

  buildKey(queryType: QueryType, canonicalId: string): string {
    const hash = createHash('md5')
      .update(canonicalId.toLowerCase().trim())
      .digest('hex');
    return `metadata:v${METADATA_POLICY_VERSION}:${queryType}:${hash}`;
  }

  /**
   * Retrieves metadata from L1 memory or L2 Redis.
   * Returns:
   * - ResolvedMetadata: Positive cache hit
   * - false: Negative cache hit (known not found)
   * - null: Cache miss
   */
  async get(key: string): Promise<ResolvedMetadata | null | false> {
    const now = Date.now();

    // 1. Tier 1: Check L1 In-Memory LRU Cache (0ms)
    const l1Entry = this.l1Cache.get(key);
    if (l1Entry) {
      if (l1Entry.expiresAt > now) {
        // Refresh LRU order
        this.l1Cache.delete(key);
        this.l1Cache.set(key, l1Entry);

        if (l1Entry.value === false) {
          this.logger.debug(`L1 Negative Cache HIT: ${key}`);
          return false;
        }
        this.logger.debug(`L1 Cache HIT (0ms): ${key}`);
        return l1Entry.value;
      } else {
        // Expired entry
        this.l1Cache.delete(key);
      }
    }

    // 2. Tier 2: Check L2 Redis Cache
    if (!this.redis || !this.redis.isReady()) {
      return null;
    }

    try {
      const raw = await this.redis.get<string | ResolvedMetadata>(key);
      if (raw === null || raw === undefined) return null;

      if (raw === NEGATIVE_SENTINEL) {
        this.logger.debug(`L2 Redis Negative Cache HIT: ${key}`);
        // Populate L1 negative entry
        this.setL1(key, false, 900);
        return false;
      }

      this.logger.debug(`L2 Redis Cache HIT: ${key}`);
      const parsed: ResolvedMetadata =
        typeof raw === 'string' ? JSON.parse(raw) : raw;

      // Populate L1 cache for subsequent 0ms hits
      this.setL1(key, parsed, 86_400);
      return parsed;
    } catch (err: any) {
      this.logger.warn(`Cache GET failed for key "${key}": ${err.message}`);
      return null;
    }
  }

  /**
   * Sets positive resolved metadata in both L1 In-Memory and L2 Redis.
   */
  async set(
    key: string,
    value: ResolvedMetadata,
    queryType: QueryType,
  ): Promise<void> {
    const ttl = this.TTL_MAP[queryType] ?? 86_400;

    // 1. Set L1 In-Memory
    this.setL1(key, value, ttl);

    // 2. Set L2 Redis
    if (!this.redis || !this.redis.isReady()) return;

    try {
      await this.redis.set(key, value, ttl);
      this.logger.debug(`L2 Redis SET (TTL=${ttl}s): ${key}`);
    } catch (err: any) {
      this.logger.warn(`L2 Cache SET failed for key "${key}": ${err.message}`);
    }
  }

  /**
   * Sets negative sentinel in both L1 In-Memory and L2 Redis.
   */
  async setNegative(key: string, queryType: QueryType): Promise<void> {
    const ttl = this.NEGATIVE_TTL_MAP[queryType] ?? 900;

    // 1. Set L1 In-Memory negative
    this.setL1(key, false, ttl);

    // 2. Set L2 Redis negative
    if (!this.redis || !this.redis.isReady()) return;

    try {
      await this.redis.set(key, NEGATIVE_SENTINEL, ttl);
      this.logger.debug(`L2 Redis Negative SET (TTL=${ttl}s): ${key}`);
    } catch (err: any) {
      this.logger.warn(
        `L2 Negative SET failed for key "${key}": ${err.message}`,
      );
    }
  }

  /**
   * Internal helper to insert/update entry in L1 LRU Cache.
   */
  private setL1(
    key: string,
    value: ResolvedMetadata | false,
    ttlSeconds: number,
  ): void {
    // Evict oldest if limit reached
    if (this.l1Cache.size >= this.MAX_L1_ENTRIES) {
      const oldestKey = this.l1Cache.keys().next().value;
      if (oldestKey) {
        this.l1Cache.delete(oldestKey);
      }
    }

    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.l1Cache.set(key, { value, expiresAt });
  }

  /**
   * Clears L1 in-memory cache (primarily for unit tests).
   */
  clearMemoryCache(): void {
    this.l1Cache.clear();
  }

  /**
   * Returns stats about cache availability and L1 occupancy.
   */
  getMemoryStats() {
    return {
      l1Size: this.l1Cache.size,
      l1Max: this.MAX_L1_ENTRIES,
      redisAvailable: Boolean(this.redis && this.redis.isReady()),
    };
  }

  get available(): boolean {
    // Available if either L1 memory or L2 Redis is active
    return true;
  }

  get redisAvailable(): boolean {
    return Boolean(this.redis && this.redis.isReady());
  }
}
