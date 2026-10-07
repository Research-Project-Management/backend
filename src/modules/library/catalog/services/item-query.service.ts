import { Injectable, Logger, Optional } from '@nestjs/common';
import { QueryRepository } from '../repositories/query.repository';
import { RedisCacheService } from '../../../../core/cache/redis.service';
import { LIBRARY_REDIS_KEYS } from '../../shared-kernel/core/constants/redis-keys.constants';
import { ItemsMapper } from '../utils/items.mapper';
import { CursorPaginatedResult } from '../dto/items.dto';
import {
  IItemReadPort,
  IItemExistencePort,
  ItemDetail,
  ItemSummary,
  QualityAuditCandidateItem,
  DuplicateCandidateItem,
} from '../types/items.types';

/**
 * ItemQueryService — Dedicated Domain Service for Item Information Retrieval.
 * Implements IItemReadPort and IItemExistencePort:
 * - Caches counts (total, unfiled, starred, trash)
 * - Single item detail retrieval with Redis acceleration
 * - Cursor pagination and filtered listing
 * - Port methods for existence checks and duplicate candidate queries
 */
@Injectable()
export class ItemQueryService implements IItemReadPort, IItemExistencePort {
  private readonly logger = new Logger(ItemQueryService.name);

  constructor(
    private readonly query: QueryRepository,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private mapFlattenedState(
    item: Record<string, any>,
    userId?: string,
  ): Record<string, any> | null {
    return ItemsMapper.mapFlattenedState(item, userId);
  }

  /**
   * Retrieves high-performance aggregated system counts (unfiled, starred, trash, total)
   * for fast sidebar rendering without downloading item arrays.
   */
  async getCounts(
    userId: string,
    projectId?: string,
  ): Promise<{
    total: number;
    unfiled: number;
    starred: number;
    trash: number;
  }> {
    const cacheKey = projectId
      ? `library:counts:proj:${projectId}`
      : `library:counts:user:${userId}`;

    if (this.cache && typeof this.cache.wrap === 'function') {
      return this.cache.wrap(
        cacheKey,
        async () => {
          const [total, unfiled, starred, trash] = await Promise.all([
            this.query.count(userId, { view: 'all', projectId }),
            this.query.count(userId, { view: 'unfiled', projectId }),
            this.query.count(userId, { view: 'starred', projectId }),
            this.query.count(userId, { view: 'trash', projectId }),
          ]);
          return { total, unfiled, starred, trash };
        },
        15, // 15s TTL for high navigation speed
      );
    }

    const [total, unfiled, starred, trash] = await Promise.all([
      this.query.count(userId, { view: 'all', projectId }),
      this.query.count(userId, { view: 'unfiled', projectId }),
      this.query.count(userId, { view: 'starred', projectId }),
      this.query.count(userId, { view: 'trash', projectId }),
    ]);
    return { total, unfiled, starred, trash };
  }

  async getItem(userId: string, id: string, projectId?: string) {
    const cacheKey = LIBRARY_REDIS_KEYS.item(id);
    if (this.cache) {
      if (typeof this.cache.wrap === 'function') {
        const cached = await this.cache.wrap<Record<string, any> | null>(
          cacheKey,
          async () => {
            const item = await this.query.findById(userId, id, projectId);
            return item ? this.mapFlattenedState(item, userId) : null;
          },
          300, // 5 min TTL
        );
        if (cached) {
          const isOwner = cached.userId === userId;
          const isProjectMatch = projectId && cached.projectId === projectId;
          if (isOwner || isProjectMatch) {
            return cached;
          }
          return null;
        }
        return null;
      }

      try {
        const cached = await this.cache.get<Record<string, any>>(cacheKey);
        if (cached) {
          const isOwner = cached.userId === userId;
          const isProjectMatch = projectId && cached.projectId === projectId;
          if (isOwner || isProjectMatch) {
            return cached;
          }
        }
      } catch (err: any) {
        this.logger.debug(
          `Cache lookup error for ${cacheKey}: ${err?.message || err}`,
        );
      }
    }

    const item = await this.query.findById(userId, id, projectId);
    if (!item) return null;
    const mapped = this.mapFlattenedState(item, userId);

    if (mapped && this.cache) {
      try {
        await this.cache.set(cacheKey, mapped, 300); // 5 min TTL
      } catch (err: any) {
        this.logger.debug(
          `Cache set error for ${cacheKey}: ${err?.message || err}`,
        );
      }
    }

    return mapped;
  }

  async listItems(
    userId: string,
    options: {
      view?:
        | 'all'
        | 'recent'
        | 'unfiled'
        | 'trash'
        | 'my-publications'
        | 'publications'
        | 'starred'
        | 'retracted';
      collectionId?: string;
      tagId?: string;
      search?: string;
      limit?: number;
      cursor?: string;
      projectId?: string;
    },
  ): Promise<CursorPaginatedResult<any>> {
    const limit = Math.min(options.limit ?? 50, 100);
    const scopeKey =
      options.projectId && options.projectId !== 'user'
        ? `proj:${options.projectId}`
        : userId;
    const canCache = !options.search && !options.cursor;
    const cacheKey = canCache
      ? LIBRARY_REDIS_KEYS.itemsList(
          scopeKey,
          `${options.view || 'all'}:${options.collectionId || ''}:${options.tagId || ''}:${limit}`,
        )
      : null;

    if (canCache && cacheKey && this.cache) {
      try {
        const cached =
          await this.cache.get<CursorPaginatedResult<any>>(cacheKey);
        if (cached) {
          return cached;
        }
      } catch (err: any) {
        this.logger.debug(
          `Cache lookup error for ${cacheKey}: ${err?.message || err}`,
        );
      }
    }

    const queryOptions = { ...options, userId };
    const isInitialPage = !options.cursor;
    const shouldCount = isInitialPage;
    const [totalCount, rawItems] = await Promise.all([
      shouldCount
        ? this.query.count(userId, queryOptions)
        : Promise.resolve(undefined),
      this.query.findMany(userId, {
        ...queryOptions,
        limit: limit + 1,
      }),
    ]);

    let hasNextPage = false;
    let nextCursor: string | undefined;

    if (rawItems.length > limit) {
      hasNextPage = true;
      rawItems.pop();
      nextCursor = rawItems[rawItems.length - 1]?.id;
    }

    const items = rawItems
      .slice(0, limit)
      .map((it) => this.mapFlattenedState(it, userId));

    const result: CursorPaginatedResult<any> = {
      items,
      meta: {
        cursor: nextCursor,
        hasNextPage,
        totalCount,
      },
    };

    if (canCache && cacheKey && this.cache) {
      try {
        await this.cache.set(cacheKey, result, 60); // 60s TTL
      } catch (err: any) {
        this.logger.debug(
          `Cache set error for ${cacheKey}: ${err?.message || err}`,
        );
      }
    }

    return result;
  }

  async getItemSnapshot(userId: string, itemId: string) {
    return this.query.getItemSnapshot(userId, itemId);
  }

  async getItemSnapshots(userId: string, itemIds: string[]) {
    return this.query.getItemSnapshots(userId, itemIds);
  }

  // ── IItemExistencePort Implementation ────────────────────────────────────

  async exists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    return this.query.exists(userId, itemId, undefined, projectId);
  }

  async assertExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    return this.query.assertExists(userId, itemId, undefined, projectId);
  }

  async existMany(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<Map<string, boolean>> {
    return this.query.existMany(userId, itemIds, undefined, projectId);
  }

  async validateItemsBelongToUser(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ valid: boolean; missingIds: string[] }> {
    const existMap = await this.existMany(userId, itemIds, projectId);
    const missingIds: string[] = [];
    for (const id of itemIds) {
      if (!existMap.get(id)) {
        missingIds.push(id);
      }
    }
    return {
      valid: missingIds.length === 0,
      missingIds,
    };
  }

  // ── IItemReadPort Implementation ─────────────────────────────────────────

  async findById(userId: string, itemId: string, projectId?: string) {
    return this.query.findById(userId, itemId, projectId);
  }

  async findByIds(userId: string, itemIds: string[], projectId?: string) {
    return this.query.findByIds(userId, itemIds, projectId);
  }

  async findByDoi(userId: string, doi: string, projectId?: string) {
    return this.query.findByDoi(userId, doi, projectId);
  }

  async findSummaryById(userId: string, itemId: string, projectId?: string) {
    return this.query.findSummaryById(userId, itemId, undefined, projectId);
  }

  async findSummariesByIds(
    userId: string,
    itemIds: string[],
    _projectId?: string,
  ) {
    return this.query.findSummariesByIds(userId, itemIds);
  }

  async findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<QualityAuditCandidateItem[]> {
    return (await this.query.findQualityAuditItems(
      userId,
      limit,
      projectId,
    )) as unknown as QualityAuditCandidateItem[];
  }

  async findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<DuplicateCandidateItem[]> {
    return (await this.query.findDuplicateCandidateItems(
      userId,
      limit,
      projectId,
    )) as unknown as DuplicateCandidateItem[];
  }

  async findCandidateItemsForQualityAudit(
    limit: number,
  ): Promise<QualityAuditCandidateItem[]> {
    return this.findQualityAuditItems('', limit);
  }

  async findCandidateItemsForDuplicateDetection(
    limit: number,
  ): Promise<DuplicateCandidateItem[]> {
    return this.findDuplicateCandidateItems('', limit);
  }
}
