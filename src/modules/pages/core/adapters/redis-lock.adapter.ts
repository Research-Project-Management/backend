/**
 * modules/manuscripts/core/adapters/redis-lock.adapter.ts
 *
 * Distributed Lock Port Adapter delegating to core DistributedLockService
 * (SET NX PX + Lua atomic unlock + in-memory fallback).
 */

import { Injectable, Optional } from '@nestjs/common';
import { DistributedLockService } from '@/core';
import {
  IDistributedLockPort,
  IDistributedLockHandle,
  InMemoryDistributedLockAdapter,
} from '../ports/distributed-lock.port';
import { DistributedLockTimeoutError } from '../domain/pages-domain.error';

@Injectable()
export class RedisLockAdapter extends IDistributedLockPort {
  private readonly inMemoryFallback = new InMemoryDistributedLockAdapter();

  constructor(
    @Optional() private readonly lockService?: DistributedLockService,
  ) {
    super();
  }

  private lockKey(resource: string): string {
    return `lock:manuscript:${resource}`;
  }

  public async acquire(
    resource: string,
    ttlMs: number = 30000,
  ): Promise<IDistributedLockHandle | null> {
    if (!this.lockService) {
      return this.inMemoryFallback.acquire(resource, ttlMs);
    }

    const key = this.lockKey(resource);
    const acquiredAt = Date.now();
    const token = await this.lockService.acquireLock(key, ttlMs);
    if (!token) {
      return null;
    }

    let released = false;
    return {
      resource,
      acquiredAt,
      release: async () => {
        if (released) return;
        released = true;
        await this.lockService?.releaseLock(key, token);
      },
    };
  }

  public async withLock<T>(
    resource: string,
    action: () => Promise<T>,
    ttlMs: number = 30000,
  ): Promise<T> {
    if (!this.lockService) {
      return this.inMemoryFallback.withLock(resource, action, ttlMs);
    }

    const startTime = Date.now();
    const maxWaitMs = Math.max(ttlMs, 30000);
    let handle = await this.acquire(resource, ttlMs);

    while (!handle) {
      if (Date.now() - startTime >= maxWaitMs) {
        throw new DistributedLockTimeoutError(resource, maxWaitMs);
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

/** @deprecated Use RedisLockAdapter */
export { RedisLockAdapter as RedisDistributedLockAdapter };
