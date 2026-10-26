import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { normalizeProjectScopeId, libraryConfig } from '@/modules/library/core';
import { TagsService } from './tags.service';

/**
 * ItemCacheCoordinator
 * Encapsulates Redis caching and invalidation logic across Item scopes, details, and fulltext entries.
 */
@Injectable()
export class ItemCacheCoordinator {
  private readonly logger = new Logger(ItemCacheCoordinator.name);

  /**
   * Adds ±10% jitter to cache TTL to prevent cache stampedes / thundering herds.
   */
  withJitter(ttlSeconds: number): number {
    if (libraryConfig().app.isTest) {
      return ttlSeconds;
    }
    return Math.max(1, Math.floor(ttlSeconds * (0.9 + Math.random() * 0.2)));
  }

  constructor(
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly tagsService?: TagsService,
  ) {}

  /**
   * Invalidates detail cache for a specific item without triggering SCAN pattern storms.
   */
  async invalidateDetailCache(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    return this.invalidateItemCache(itemId, userId, projectId);
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
      const keysToDelete: string[] = [
        LIBRARY_REDIS_KEYS.item(id),
        LIBRARY_REDIS_KEYS.itemDetails(id),
        LIBRARY_REDIS_KEYS.itemFulltext(id),
        `${LIBRARY_REDIS_KEYS.item(id)}:attachments`,
        `${LIBRARY_REDIS_KEYS.item(id)}:notes`,
      ];
      if (userId) {
        keysToDelete.push(`${LIBRARY_REDIS_KEYS.item(id)}:u:${userId}`);
      }
      await Promise.all(keysToDelete.map((k) => this.cache!.del(k)));
      if (!options?.skipScopeInvalidation && userId) {
        await this.invalidateScopeListCache(userId, projectId);
      }
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
      const validProjectId = normalizeProjectScopeId(projectId);
      const tasks: Promise<unknown>[] = [
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.searchFacetsPattern(userId)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.searchItemsPattern(userId)),
        this.cache.del(LIBRARY_REDIS_KEYS.searchVersion(userId)),
        this.invalidateCounts(userId),
      ];
      if (this.tagsService) {
        tasks.push(this.tagsService.invalidateTagsCache(userId, validProjectId));
      }
      if (validProjectId) {
        tasks.push(
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.itemsPattern(`proj:${validProjectId}`),
          ),
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.itemsPattern(validProjectId),
          ),
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.searchFacetsPattern(validProjectId),
          ),
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.searchItemsPattern(validProjectId),
          ),
          this.cache.del(LIBRARY_REDIS_KEYS.searchVersion(validProjectId)),
          this.cache.del(LIBRARY_REDIS_KEYS.searchVersion(`proj:${validProjectId}`)),
          this.invalidateCounts(validProjectId),
        );
      }
      await Promise.all(tasks);
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
    if (itemIds.length === 0) return;
    if (!this.cache) return;

    try {
      const uniqueIds = Array.from(new Set(itemIds));
      const keysToDelete: string[] = [];
      for (const id of uniqueIds) {
        keysToDelete.push(
          LIBRARY_REDIS_KEYS.item(id),
          `${LIBRARY_REDIS_KEYS.item(id)}:u:${userId}`,
          LIBRARY_REDIS_KEYS.itemDetails(id),
          LIBRARY_REDIS_KEYS.itemFulltext(id),
          `${LIBRARY_REDIS_KEYS.item(id)}:attachments`,
          `${LIBRARY_REDIS_KEYS.item(id)}:notes`,
        );
      }
      const directKeyDeletions = keysToDelete.map((k) => this.cache!.del(k));

      const uniqueScopes = new Set<string>();
      const validBaseProject = normalizeProjectScopeId(projectId);
      uniqueScopes.add(validBaseProject || '');
      if (additionalProjectIds) {
        for (const pid of additionalProjectIds) {
          const norm = normalizeProjectScopeId(pid ?? undefined);
          uniqueScopes.add(norm || '');
        }
      }

      const scopeInvalidations = Array.from(uniqueScopes).map((scopeProjId) =>
        this.invalidateScopeListCache(userId, scopeProjId || undefined),
      );

      await Promise.all([...directKeyDeletions, ...scopeInvalidations]);
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
    const validProjectId = normalizeProjectScopeId(params.projectId ?? undefined);
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
