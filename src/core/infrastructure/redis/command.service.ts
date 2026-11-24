import { Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { getErrorMessage } from '../../utils/error.util';
import { RedisCacheService } from './cache.service';

/**
 * Low-level Redis Command & Lua Script Adapter.
 * Encapsulates raw ioredis access (Lua EVAL, Pipelines, Lists/Hashes/Sets)
 * behind a single readiness + error-handling seam so callers never touch
 * `RedisCacheService.getClient()` directly.
 */
@Injectable()
export class RedisCommandService {
  private readonly logger = new Logger(RedisCommandService.name);

  constructor(private readonly redisCache: RedisCacheService) {}

  public isReady(): boolean {
    return this.redisCache.isReady() && this.redisCache.getClient() !== null;
  }

  /**
   * Executes a Lua script atomically on Redis.
   * Returns `null` when Redis is offline or the command fails.
   */
  public async evalScript<T>(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<T | null> {
    const client = this.redisCache.isReady()
      ? this.redisCache.getClient()
      : null;
    if (!client) return null;

    try {
      return (await client.eval(script, keys.length, ...keys, ...args)) as T;
    } catch (err: unknown) {
      this.logger.warn(`Redis evalScript failed: ${getErrorMessage(err)}`);
      return null;
    }
  }

  /**
   * Executes a multi-command callback (Pipeline, List, Hash, Set, Stream)
   * against the underlying ioredis client with unified readiness & error guard.
   */
  public async withClient<T>(
    operation: string,
    fn: (client: Redis) => Promise<T>,
  ): Promise<T | null> {
    const client = this.redisCache.isReady()
      ? this.redisCache.getClient()
      : null;
    if (!client) return null;

    try {
      return await fn(client);
    } catch (err: unknown) {
      this.logger.warn(
        `Redis operation "${operation}" failed: ${getErrorMessage(err)}`,
      );
      return null;
    }
  }
}
