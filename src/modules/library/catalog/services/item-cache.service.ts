import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core';
import {
  normalizeProjectSpaceId,
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

  async invalidateItemCache(
    id: string,
    userId?: string,
    projectId?: string,
    options?: {
      skipScopeInvalidation?: boolean;
      onlyUserStateOverlay?: boolean;
      preserveContentCaches?: boolean;
    },
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await invalidateLibraryScopeCaches(this.cache, {
        userId,
        projectId,
        itemIds: [id],
        skipScopeInvalidation:
          options?.skipScopeInvalidation === true || !userId,
        onlyUserStateOverlay: options?.onlyUserStateOverlay,
        preserveContentCaches: options?.preserveContentCaches,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate cache for item ${id}: ${message}`);
    }
  }

  async invalidateScopeListCache(
    userId: string,
    projectId?: string,
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await invalidateLibraryScopeCaches(this.cache, { userId, projectId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate scope caches: ${message}`);
    }
  }

  async invalidateBulkItemsCache(
    itemIds: string[],
    userId: string,
    projectId?: string,
    additionalProjectIds?: Array<string | null | undefined>,
    options?: {
      skipScopeInvalidation?: boolean;
      onlyUserStateOverlay?: boolean;
      preserveContentCaches?: boolean;
    },
  ): Promise<void> {
    if (itemIds.length === 0 || !this.cache) return;
    try {
      await invalidateLibraryScopeCaches(this.cache, {
        userId,
        projectId,
        itemIds,
        additionalProjectIds,
        skipScopeInvalidation: options?.skipScopeInvalidation,
        onlyUserStateOverlay: options?.onlyUserStateOverlay,
        preserveContentCaches: options?.preserveContentCaches,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to invalidate bulk item caches (${itemIds.length} items): ${message}`,
      );
    }
  }

  async invalidateForWrite(params: {
    userId: string;
    projectId?: string | null;
    itemIds?: string[];
    additionalProjectIds?: Array<string | null | undefined>;
    skipScopeInvalidation?: boolean;
    onlyUserStateOverlay?: boolean;
    preserveContentCaches?: boolean;
  }): Promise<void> {
    const validProjectId = normalizeProjectSpaceId(
      params.projectId ?? undefined,
    );
    if (params.itemIds && params.itemIds.length > 0) {
      await this.invalidateBulkItemsCache(
        params.itemIds,
        params.userId,
        validProjectId,
        params.additionalProjectIds,
        {
          skipScopeInvalidation: params.skipScopeInvalidation,
          onlyUserStateOverlay: params.onlyUserStateOverlay,
          preserveContentCaches: params.preserveContentCaches,
        },
      );
      return;
    }
    if (!params.skipScopeInvalidation) {
      await this.invalidateScopeListCache(params.userId, validProjectId);
    }
  }
}
