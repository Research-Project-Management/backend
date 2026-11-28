/**
 * modules/pages/core/adapters/redis-lock.adapter.ts
 *
 * Distributed Lock Port Adapter delegating directly to core DistributedLockService
 * (SET NX PX + Lua atomic unlock + built-in in-memory fallback).
 */

import { Injectable } from '@nestjs/common';
import { DistributedLockService } from '@/core';
import {
  IDistributedLockPort,
  IDistributedLockHandle,
} from '../ports/distributed-lock.port';
import { DistributedLockTimeoutError } from '../domain/errors';
import { PAGES_CACHE_KEYS } from '../config/cache-keys';

@Injectable()
export class RedisLockAdapter extends IDistributedLockPort {
  constructor(private readonly lockService: DistributedLockService) {
    super();
  }

  private lockKey(resource: string): string {
    return PAGES_CACHE_KEYS.lock(resource);
  }

  public async acquire(
    resource: string,
    ttlMs: number = 30000,
  ): Promise<IDistributedLockHandle | null> {
    const key = this.lockKey(resource);
    const acquiredAt = Date.now();
    const token = await this.lockService.acquireLock(key, ttlMs);
    if (!token) {
      return null;
    }

    let released = false;
    const heartbeatMs = Math.max(1000, Math.floor(ttlMs / 3));

    const renewalTimer =
      typeof this.lockService.extendLock === 'function' && ttlMs >= 3000
        ? setInterval(() => {
            if (released) return;
            void this.lockService
              .extendLock(key, token, ttlMs)
              .catch(() => undefined);
          }, heartbeatMs)
        : null;
    if (renewalTimer && typeof renewalTimer.unref === 'function') {
      renewalTimer.unref();
    }

    return {
      resource,
      acquiredAt,
      release: async () => {
        if (released) return;
        released = true;
        if (renewalTimer) {
          clearInterval(renewalTimer);
        }
        await this.lockService.releaseLock(key, token);
      },
    };
  }

  public async withLock<T>(
    resource: string,
    action: () => Promise<T>,
    ttlMs: number = 30000,
  ): Promise<T> {
    const startTime = Date.now();
    const maxWaitMs = Math.max(ttlMs, 30000);
    let handle = await this.acquire(resource, ttlMs);
    let attempt = 0;

    while (!handle) {
      if (Date.now() - startTime >= maxWaitMs) {
        throw new DistributedLockTimeoutError(resource, maxWaitMs);
      }
      const baseDelay = Math.min(50 * 2 ** attempt, 1000);
      const delay = Math.floor(baseDelay * (0.5 + Math.random() * 0.5));
      attempt += 1;
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

/** @deprecated Use RedisLockAdapter */
export { RedisLockAdapter as RedisDistributedLockAdapter };
