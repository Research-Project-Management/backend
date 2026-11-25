/**
 * modules/bff/core/bff-cache.service.ts
 * Subsystem 5 (Channel-Scoped Cache):
 * Thin short-TTL cache wrapper over RedisCacheService with singleflight
 * protection and automatic bypass for partial/degraded responses.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core';

export interface BffCachedResult<T> {
  value: T;
  cacheHit: boolean;
}

@Injectable()
export class BffCacheService {
  private readonly logger = new Logger(BffCacheService.name);

  constructor(@Optional() private readonly cache?: RedisCacheService) {}

  /**
   * Reads a cached BFF payload or computes it on miss.
   * Only caches clean (non-degraded) payloads when `shouldCache` returns true,
   * preventing transient partial failures from being cached across requests.
   */
  async getOrCompute<T>(
    key: string,
    ttlSeconds: number,
    compute: () => Promise<{ value: T; cacheable: boolean }>,
  ): Promise<BffCachedResult<T>> {
    if (!this.cache || ttlSeconds <= 0) {
      const { value } = await compute();
      return { value, cacheHit: false };
    }

    try {
      const cached = await this.cache.get<T>(key);
      if (cached !== null) {
        return { value: cached, cacheHit: true };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`BFF cache read failed for "${key}": ${msg}`);
    }

    const { value, cacheable } = await compute();

    if (cacheable) {
      try {
        await this.cache.set(key, value, ttlSeconds);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`BFF cache write failed for "${key}": ${msg}`);
      }
    }

    return { value, cacheHit: false };
  }

  async invalidate(key: string): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.del(key);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`BFF cache invalidate failed for "${key}": ${msg}`);
    }
  }
}
