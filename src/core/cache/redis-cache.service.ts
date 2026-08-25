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
  private readonly logger = new Logger(RedisCacheService.name);

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const redisUrl =
      this.configService.get<string>('REDIS_URL') ||
      process.env.REDIS_URL ||
      'redis://localhost:6379';

    try {
      this.redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          // Bounded exponential backoff: retry periodically without giving up permanently
          return Math.min(times * 500, 3000);
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
        // ignore on shutdown
      }
    }
  }

  isReady(): boolean {
    return this.isConnected && this.redisClient !== null;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isReady() || !this.redisClient) return null;
    try {
      const data = await this.redisClient.get(key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch (err: unknown) {
      this.logger.warn(
        `Cache get failed for key "${key}": ${getErrorMessage(err)}`,
      );
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number = 300): Promise<void> {
    if (!this.isReady() || !this.redisClient) return;
    try {
      const serialized = JSON.stringify(value);
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
   * Invalidate all keys matching a workspace scope
   */
  async invalidateWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    await this.delPattern(`*${workspaceId}*`);
  }

  /**
   * Invalidate all keys matching a project scope
   */
  async invalidateProject(projectId: string): Promise<void> {
    if (!projectId) return;
    await this.delPattern(`*${projectId}*`);
  }

  /**
   * Invalidate a single entity key
   */
  async invalidateEntity(entityType: string, entityId: string): Promise<void> {
    if (!entityType || !entityId) return;
    await this.del(`${entityType}:${entityId}`);
    await this.delPattern(`${entityType}:${entityId}:*`);
  }
}
