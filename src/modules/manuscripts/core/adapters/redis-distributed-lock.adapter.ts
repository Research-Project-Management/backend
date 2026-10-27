/**
 * modules/manuscripts/core/adapters/redis-distributed-lock.adapter.ts
 *
 * Distributed Lock Port Adapter using Redis SET NX PX + Lua atomic unlock.
 * Gracefully falls back to InMemoryDistributedLockAdapter when Redis
 * is disconnected, unavailable, or in memory-only test environments.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core/infrastructure/redis/redis.service';
import {
  IDistributedLockPort,
  IDistributedLockHandle,
  InMemoryDistributedLockAdapter,
} from '../ports/distributed-lock.port';
import * as crypto from 'crypto';

@Injectable()
export class RedisDistributedLockAdapter extends IDistributedLockPort {
  private readonly logger = new Logger(RedisDistributedLockAdapter.name);
  private readonly inMemoryFallback = new InMemoryDistributedLockAdapter();

  /**
   * Atomic release script ensuring only the specific token holder releases the lock.
   */
  private static readonly UNLOCK_LUA_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(@Optional() private readonly redis?: RedisCacheService) {
    super();
  }

  private isRedisUsable(): boolean {
    return Boolean(
      this.redis &&
        typeof this.redis.isReady === 'function' &&
        this.redis.isReady() &&
        this.redis.getClient(),
    );
  }

  private lockKey(resource: string): string {
    return `manuscript:lock:${resource}`;
  }

  public async acquire(
    resource: string,
    ttlMs: number = 30000,
  ): Promise<IDistributedLockHandle | null> {
    if (!this.isRedisUsable()) {
      return this.inMemoryFallback.acquire(resource, ttlMs);
    }

    const client = this.redis!.getClient();
    if (!client) {
      return this.inMemoryFallback.acquire(resource, ttlMs);
    }

    const key = this.lockKey(resource);
    const token = crypto.randomUUID();
    const acquiredAt = Date.now();

    try {
      // Redis SET key token PX ttlMs NX -> returns 'OK' if key was set, null otherwise
      const result = await client.set(key, token, 'PX', ttlMs, 'NX');
      if (result !== 'OK') {
        return null;
      }

      let released = false;
      const releaseFn = async () => {
        if (released) return;
        released = true;

        try {
          if (this.isRedisUsable()) {
            const currentClient = this.redis!.getClient();
            if (currentClient) {
              await currentClient.eval(
                RedisDistributedLockAdapter.UNLOCK_LUA_SCRIPT,
                1,
                key,
                token,
              );
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.debug(
            `Failed to release Redis lock for "${resource}": ${msg}`,
          );
        }
      };

      return {
        resource,
        acquiredAt,
        release: releaseFn,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Redis lock acquire error on "${resource}", falling back to in-memory: ${msg}`,
      );
      return this.inMemoryFallback.acquire(resource, ttlMs);
    }
  }

  public async withLock<T>(
    resource: string,
    action: () => Promise<T>,
    ttlMs: number = 30000,
  ): Promise<T> {
    if (!this.isRedisUsable()) {
      return this.inMemoryFallback.withLock(resource, action, ttlMs);
    }

    const startTime = Date.now();
    const maxWaitMs = Math.max(ttlMs, 30000);
    let handle = await this.acquire(resource, ttlMs);

    while (!handle) {
      if (Date.now() - startTime >= maxWaitMs) {
        throw new Error(
          `Failed to acquire distributed lock for resource "${resource}" within ${maxWaitMs}ms`,
        );
      }
      // Exponential jittered backoff between 50ms and 200ms
      const delay = Math.floor(50 + Math.random() * 150);
      await new Promise((resolve) => setTimeout(resolve, delay));
      handle = await this.acquire(resource, ttlMs);
    }

    try {
      return await action();
    } finally {
      await handle.release().catch(() => {});
    }
  }
}
