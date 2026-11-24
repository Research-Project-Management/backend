import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { getErrorMessage } from '../../utils/error.util';
import { RedisCacheService } from './cache.service';

/**
 * Distributed Mutex Lock Service (SET NX PX + Lua Atomic Release/Extend).
 * Uses Redis when connected and falls back to an in-memory lock map when offline.
 */
@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);
  private readonly inMemoryLocks = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  private static readonly UNLOCK_LUA_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  private static readonly EXTEND_LOCK_LUA_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], tonumber(ARGV[2]))
    else
      return 0
    end
  `;

  constructor(private readonly redisCache: RedisCacheService) {}

  private toLockKey(resource: string): string {
    return resource.startsWith('lock:') ? resource : `lock:${resource}`;
  }

  /**
   * Acquires a distributed mutex lock using atomic Redis SET NX PX.
   * Returns a unique lock token (UUID) if acquired, or null if held.
   */
  public async acquireLock(
    resource: string,
    ttlMs: number = 30000,
  ): Promise<string | null> {
    const token = crypto.randomUUID();
    const lockKey = this.toLockKey(resource);
    const client = this.redisCache.isReady()
      ? this.redisCache.getClient()
      : null;

    if (client) {
      try {
        const result = await client.set(lockKey, token, 'PX', ttlMs, 'NX');
        return result === 'OK' ? token : null;
      } catch (err: unknown) {
        this.logger.warn(
          `Redis acquireLock failed for "${resource}": ${getErrorMessage(err)}`,
        );
      }
    }

    const now = Date.now();
    const current = this.inMemoryLocks.get(lockKey);
    if (!current || current.expiresAt <= now) {
      this.inMemoryLocks.set(lockKey, { token, expiresAt: now + ttlMs });
      return token;
    }
    return null;
  }

  /**
   * Releases a distributed mutex lock atomically via Lua script, ensuring
   * only the token holder can release the lock.
   */
  public async releaseLock(resource: string, token: string): Promise<boolean> {
    const lockKey = this.toLockKey(resource);
    const client = this.redisCache.isReady()
      ? this.redisCache.getClient()
      : null;

    if (client) {
      try {
        const result = (await client.eval(
          DistributedLockService.UNLOCK_LUA_SCRIPT,
          1,
          lockKey,
          token,
        )) as number;
        return result === 1;
      } catch (err: unknown) {
        this.logger.warn(
          `Redis releaseLock failed for "${resource}": ${getErrorMessage(err)}`,
        );
      }
    }

    const current = this.inMemoryLocks.get(lockKey);
    if (current && current.token === token) {
      this.inMemoryLocks.delete(lockKey);
      return true;
    }
    return false;
  }

  private async extendLock(
    resource: string,
    token: string,
    ttlMs: number = 30000,
  ): Promise<boolean> {
    const lockKey = this.toLockKey(resource);
    const client = this.redisCache.isReady()
      ? this.redisCache.getClient()
      : null;

    if (client) {
      try {
        const result = (await client.eval(
          DistributedLockService.EXTEND_LOCK_LUA_SCRIPT,
          1,
          lockKey,
          token,
          ttlMs,
        )) as number;
        return result === 1;
      } catch (err: unknown) {
        this.logger.warn(
          `Redis extendLock failed for "${resource}": ${getErrorMessage(err)}`,
        );
      }
    }

    const now = Date.now();
    const current = this.inMemoryLocks.get(lockKey);
    if (current && current.token === token && current.expiresAt > now) {
      current.expiresAt = now + ttlMs;
      return true;
    }
    return false;
  }

  /**
   * Executes a callback within a distributed lock scope.
   * Automatically releases the lock when callback completes or throws.
   */
  public async withLock<T>(
    resource: string,
    ttlMs: number,
    fn: (handle: { heartbeat: () => Promise<boolean> }) => Promise<T>,
  ): Promise<T | null> {
    const token = await this.acquireLock(resource, ttlMs);
    if (!token) {
      return null;
    }

    const heartbeat = () => this.extendLock(resource, token, ttlMs);

    try {
      return await fn({ heartbeat });
    } finally {
      await this.releaseLock(resource, token);
    }
  }
}
