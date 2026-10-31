import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import {
  normalizeProjectScopeId,
  libraryConfig,
  invalidateLibraryScopeCaches,
} from '@/modules/library/core';

/**
 * ItemCacheCoordinator
 * Encapsulates Redis caching and invalidation logic across Item scopes, details, and fulltext entries.
 */
@Injectable()
export class ItemCacheCoordinator {
  private readonly logger = new Logger(ItemCacheCoordinator.name);
  private readonly isTestEnv = libraryConfig().app.isTest;

  constructor(@Optional() private readonly cache?: RedisCacheService) {}

  /**
   * Adds ±10% jitter to cache TTL to prevent cache stampedes / thundering herds.
   */
  withJitter(ttlSeconds: number): number {
    if (this.isTestEnv) {
      return ttlSeconds;
    }
    return Math.max(1, Math.floor(ttlSeconds * (0.9 + Math.random() * 0.2)));
  }

  /**
   * Invalidates detail cache for a specific item without triggering SCAN pattern storms.
   */
  async invalidateDetailCache(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    return this.invalidateItemCache(itemId, userId, projectId, {
      skipScopeInvalidation: true,
    });
  }

  /**
   * Invalidates Redis cache entries for an item and affected library lists.
   */
  async invalidateItemCache(
    id: string,
    userId?: string,
    projectId?: string,
    options?: { skipScopeInvalidation?: boolean },
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await invalidateLibraryScopeCaches(this.cache, {
        userId,
        projectId,
        itemIds: [id],
        skipScopeInvalidation:
          options?.skipScopeInvalidation === true || !userId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate cache for item ${id}: ${message}`);
    }
  }

  /**
   * Invalidates aggregated counts cache for a specific scope (userId or projectId).
   */
  async invalidateCounts(scopeId: string): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.delPattern(LIBRARY_REDIS_KEYS.countsPattern(scopeId));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to invalidate counts for scope ${scopeId}: ${message}`,
      );
    }
  }

  /**
   * Performs a single scope-level cache invalidation for list/count/tag caches.
   */
  async invalidateScopeListCache(
    userId: string,
    projectId?: string,
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await invalidateLibraryScopeCaches(this.cache, {
        userId,
        projectId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate scope caches: ${message}`);
    }
  }

  /**
   * Batch invalidates Redis cache entries across multiple items and scopes.
   */
  async invalidateBulkItemsCache(
    itemIds: string[],
    userId: string,
    projectId?: string,
    additionalProjectIds?: Array<string | null | undefined>,
  ): Promise<void> {
    if (itemIds.length === 0 || !this.cache) return;
    try {
      await invalidateLibraryScopeCaches(this.cache, {
        userId,
        projectId,
        itemIds,
        additionalProjectIds,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to invalidate bulk item caches (${itemIds.length} items): ${message}`,
      );
    }
  }

  /**
   * Unified write-path invalidation helper for item mutations across services.
   */
  async invalidateForWrite(params: {
    userId: string;
    projectId?: string | null;
    itemIds?: string[];
    additionalProjectIds?: Array<string | null | undefined>;
  }): Promise<void> {
    const validProjectId = normalizeProjectScopeId(
      params.projectId ?? undefined,
    );
    if (params.itemIds && params.itemIds.length > 0) {
      await this.invalidateBulkItemsCache(
        params.itemIds,
        params.userId,
        validProjectId,
        params.additionalProjectIds,
      );
      return;
    }
    await this.invalidateScopeListCache(params.userId, validProjectId);
  }
}
