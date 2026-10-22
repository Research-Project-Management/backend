import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { TagsService } from './tags.service';

/**
 * ItemCacheCoordinator
 * Encapsulates Redis caching and invalidation logic across Item scopes, details, and fulltext entries.
 */
@Injectable()
export class ItemCacheCoordinator {
  private readonly logger = new Logger(ItemCacheCoordinator.name);

  constructor(
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly tagsService?: TagsService,
  ) {}

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
      await Promise.all([
        this.cache.del(LIBRARY_REDIS_KEYS.item(id)),
        this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
        this.cache.del(LIBRARY_REDIS_KEYS.itemFulltext(id)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(id)),
      ]);
      if (!options?.skipScopeInvalidation && userId) {
        await this.invalidateScopeListCache(userId, projectId);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate cache for item ${id}: ${message}`);
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
        this.cache.del(`library:counts:user:${userId}`),
      ];
      if (this.tagsService) {
        tasks.push(this.tagsService.invalidateTagsCache(userId, validProjectId));
      }
      if (validProjectId) {
        tasks.push(
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.itemsPattern(`proj:${validProjectId}`),
          ),
          this.cache.del(`library:counts:proj:${validProjectId}`),
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
      const directKeyDeletions: Promise<unknown>[] = [];
      for (const id of uniqueIds) {
        directKeyDeletions.push(
          this.cache.del(LIBRARY_REDIS_KEYS.item(id)),
          this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
          this.cache.del(LIBRARY_REDIS_KEYS.itemFulltext(id)),
        );
      }

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
}
