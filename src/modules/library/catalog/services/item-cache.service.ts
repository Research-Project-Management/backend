import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core';
import { TagsService } from './tags.service';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';

@Injectable()
export class ItemCacheService {
  private readonly logger = new Logger(ItemCacheService.name);

  constructor(
    private readonly tagsService: TagsService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  async invalidateItemCache(
    id: string,
    userId?: string,
    projectId?: string,
    options?: { skipScopeInvalidation?: boolean },
  ): Promise<void> {
    if (!this.cache) return;
    try {
      const tasks: Promise<unknown>[] = [
        this.cache.del(LIBRARY_REDIS_KEYS.item(id)),
        this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
        this.cache.del(LIBRARY_REDIS_KEYS.itemFulltext(id)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(id)),
      ];
      if (!options?.skipScopeInvalidation) {
        this.appendScopeCacheInvalidationTasks(tasks, userId, projectId);
      }
      await Promise.all(tasks);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate item cache for ${id}: ${message}`);
    }
  }

  appendScopeCacheInvalidationTasks(
    tasks: Promise<unknown>[],
    userId?: string,
    projectId?: string,
  ): void {
    if (!this.cache) return;
    if (userId) {
      tasks.push(
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
        this.cache.del(`library:counts:user:${userId}`),
      );
    }
    if (projectId && projectId !== 'user') {
      tasks.push(
        this.cache.delPattern(
          LIBRARY_REDIS_KEYS.itemsPattern(`proj:${projectId}`),
        ),
        this.cache.del(`library:counts:proj:${projectId}`),
      );
    }
  }

  async invalidateScopeCachesOnce(
    userId: string,
    projectId?: string,
  ): Promise<void> {
    await this.tagsService.invalidateTagsCache(userId, projectId);
    if (!this.cache) return;
    try {
      const tasks: Promise<unknown>[] = [];
      this.appendScopeCacheInvalidationTasks(tasks, userId, projectId);
      if (tasks.length > 0) {
        await Promise.all(tasks);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to invalidate scope cache for user ${userId}: ${message}`,
      );
    }
  }
}
