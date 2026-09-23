/**
 * document-updater/core/adapters/lock/redis-distributed-updater-lock.adapter.ts
 * Driven Adapter implementing IUpdaterLockPort using Redis SET NX PX distributed lock.
 */

import { Injectable } from '@nestjs/common';
import { IUpdaterLockPort } from '../../ports/updater-lock.port';
import { RedisCacheService } from '@/core/cache/redis.service';

@Injectable()
export class RedisDistributedUpdaterLockAdapter extends IUpdaterLockPort {
  private readonly memoryFallback = new Map<string, number>();

  constructor(private readonly redisService: RedisCacheService) {
    super();
  }

  private lockKey(resourceKey: string): string {
    return `docupdater:lock:${resourceKey}`;
  }

  public async acquire(resourceKey: string, ttlMs = 15000): Promise<boolean> {
    try {
      const client = this.redisService.getClient();
      if (client) {
        // Atomic SET lockKey "locked" NX PX ttlMs
        const result = await client.set(this.lockKey(resourceKey), 'locked', 'PX', ttlMs, 'NX');
        return result === 'OK';
      }
    } catch {
      // Fallback
    }

    // Memory fallback
    const now = Date.now();
    const existing = this.memoryFallback.get(resourceKey);
    if (existing && existing > now) {
      return false;
    }
    this.memoryFallback.set(resourceKey, now + ttlMs);
    return true;
  }

  public async release(resourceKey: string): Promise<void> {
    try {
      const client = this.redisService.getClient();
      if (client) {
        await client.del(this.lockKey(resourceKey));
      }
    } catch {
      // Fallback
    }
    this.memoryFallback.delete(resourceKey);
  }

  public async isLocked(resourceKey: string): Promise<boolean> {
    try {
      const client = this.redisService.getClient();
      if (client) {
        const val = await client.get(this.lockKey(resourceKey));
        return val !== null;
      }
    } catch {
      // Fallback
    }
    const exp = this.memoryFallback.get(resourceKey);
    return Boolean(exp && exp > Date.now());
  }
}
