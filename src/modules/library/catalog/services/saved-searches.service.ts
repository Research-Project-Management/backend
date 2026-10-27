import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisCacheService } from '@/core';
import { SavedSearchesRepository } from '@/modules/library/catalog/repositories/saved-searches.repository';
import { ConditionEvaluatorEngine } from '@/modules/library/catalog/domain/condition-evaluator.engine';
import {
  CreateSavedSearchDto,
  UpdateSavedSearchDto,
  PreviewSavedSearchDto,
  ExecuteSavedSearchQueryDto,
} from '@/modules/library/catalog/dto/saved-search.dto';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import {
  SavedSearchConditionGroup,
  ExecuteSavedSearchOptions,
} from '@/modules/library/catalog/types/saved-search.types';
import {
  LIBRARY_EVENT_TYPES,
  TransactionHelpers,
  normalizeProjectScopeId,
} from '@/modules/library/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { TransactionService } from '@/modules/library/sync';

@Injectable()
export class SavedSearchesService {
  private readonly logger = new Logger(SavedSearchesService.name);

  constructor(
    private readonly repo: SavedSearchesRepository,
    private readonly evaluator: ConditionEvaluatorEngine,
    @Optional() private readonly libraryTx?: TransactionService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateCache(userId: string, projectId?: string | null) {
    if (!this.cache) return;
    const validProjectId = normalizeProjectScopeId(projectId || undefined);
    const scopeKey = validProjectId || userId;
    await this.cache.del(LIBRARY_REDIS_KEYS.savedSearches(scopeKey)).catch(() => undefined);
  }

  async createSavedSearch(
    userId: string,
    dto: CreateSavedSearchDto,
    projectId?: string,
  ) {
    return this.create(userId, dto, projectId);
  }

  async create(userId: string, dto: CreateSavedSearchDto, projectId?: string) {
    const effectiveProjectId = normalizeProjectScopeId(
      projectId || dto.projectId,
    );
    if (!dto.conditions || typeof dto.conditions !== 'object' || Array.isArray(dto.conditions)) {
      throw new BadRequestException('Saved search conditions must be a valid condition group object');
    }
    if (dto.scopeOptions && dto.conditions) {
      dto.conditions.scopeOptions =
        dto.conditions.scopeOptions || dto.scopeOptions;
    }
    let where: Prisma.ItemWhereInput;
    try {
      where = await this.evaluator.compile(
        userId,
        dto.conditions,
        effectiveProjectId,
      );
    } catch (err: unknown) {
      if (err instanceof BadRequestException) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Invalid saved search conditions: ${message}`);
    }
    let initialCount = 0;
    try {
      initialCount = await this.repo.countMatchingItems(where);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to evaluate initial count: ${message}`);
    }

    if (this.libraryTx) {
      const created = await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          const createdRecord = await this.repo.create(
            userId,
            dto,
            effectiveProjectId,
            tx,
          );
          if (initialCount > 0) {
            await this.repo.updateCachedCount(createdRecord.id, initialCount, tx);
            createdRecord.cachedCount = initialCount;
          }
          const eventScope = { userId, projectId: effectiveProjectId };
          await helpers.appendChange(eventScope, {
            entityType: 'SavedSearch',
            entityId: createdRecord.id,
            action: 'create',
            version: createdRecord.version ?? 1,
            data: createdRecord,
          });
          await helpers.publishOutbox(
            eventScope,
            createdRecord.id,
            LIBRARY_EVENT_TYPES.SAVED_SEARCH_CREATED,
            createdRecord,
          );
          return createdRecord;
        },
      );
      await this.invalidateCache(userId, effectiveProjectId);
      return created;
    }

    const created = await this.repo.create(userId, dto, effectiveProjectId);
    if (initialCount > 0) {
      await this.repo.updateCachedCount(created.id, initialCount);
      created.cachedCount = initialCount;
    }
    await this.invalidateCache(userId, effectiveProjectId);
    return created;
  }

  private async refreshSavedSearchCounts<
    T extends {
      id: string;
      conditions?: unknown;
      projectId?: string | null;
      cachedCount?: number | null;
      lastEvaluatedAt?: Date | null;
    },
  >(
    userId: string,
    searches: T[],
    fallbackProjectId?: string,
  ): Promise<T[]> {
    if (!Array.isArray(searches) || searches.length === 0) return searches;
    await Promise.all(
      searches.map(async (saved) => {
        if (
          !saved.conditions ||
          typeof saved.conditions !== 'object' ||
          Array.isArray(saved.conditions)
        ) {
          return;
        }
        try {
          const effectiveProj = normalizeProjectScopeId(
            fallbackProjectId || saved.projectId || undefined,
          );
          const where = await this.evaluator.compile(
            userId,
            saved.conditions as SavedSearchConditionGroup,
            effectiveProj,
          );
          const count = await this.repo.countMatchingItems(where);
          if (typeof count === 'number' && count !== saved.cachedCount) {
            saved.cachedCount = count;
            await this.repo
              .updateCachedCount(saved.id, count)
              .catch(() => undefined);
          }
        } catch {
          // Keep existing cachedCount on evaluation failure
        }
      }),
    );
    return searches;
  }

  async findAll(userId: string, projectId?: string) {
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeKey = validProjectId || userId;
    const cacheKey = LIBRARY_REDIS_KEYS.savedSearches(scopeKey);
    const loadAndRefresh = async () => {
      const list = await this.repo.findAll(userId, validProjectId);
      return this.refreshSavedSearchCounts(userId, list, validProjectId);
    };
    if (this.cache) {
      return this.cache.wrap(cacheKey, loadAndRefresh, 300);
    }
    return loadAndRefresh();
  }

  async findById(userId: string, id: string, projectId?: string) {
    const record = await this.repo.findById(userId, id, projectId);
    if (!record) {
      throw new NotFoundException(`Saved search ${id} not found`);
    }
    return record;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateSavedSearchDto,
    projectId?: string,
  ) {
    const existing = await this.findById(userId, id, projectId);
    const effectiveProjectId = normalizeProjectScopeId(
      projectId || existing.projectId,
    );

    let recalculatedCount: number | undefined;
    if (dto.conditions) {
      if (typeof dto.conditions !== 'object' || Array.isArray(dto.conditions)) {
        throw new BadRequestException('Saved search conditions must be a valid condition group object');
      }
      if (dto.scopeOptions) {
        dto.conditions.scopeOptions =
          dto.conditions.scopeOptions || dto.scopeOptions;
      }
      let where: Prisma.ItemWhereInput;
      try {
        where = await this.evaluator.compile(
          userId,
          dto.conditions,
          effectiveProjectId,
        );
      } catch (err: unknown) {
        if (err instanceof BadRequestException) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new BadRequestException(`Invalid saved search conditions: ${message}`);
      }
      try {
        recalculatedCount = await this.repo.countMatchingItems(where);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to update cached count: ${message}`);
      }
    }

    if (this.libraryTx) {
      const updated = await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          await this.repo.update(userId, id, dto, projectId, tx);
          if (recalculatedCount !== undefined) {
            await this.repo.updateCachedCount(id, recalculatedCount, tx);
          }
          const updatedRecord = await this.repo.findById(userId, id, projectId, tx);
          if (!updatedRecord) {
            throw new NotFoundException(`Saved search ${id} not found`);
          }
          const eventScope = { userId, projectId: effectiveProjectId };
          await helpers.appendChange(eventScope, {
            entityType: 'SavedSearch',
            entityId: id,
            action: 'update',
            version: updatedRecord.version ?? 1,
            data: updatedRecord,
          });
          await helpers.publishOutbox(
            eventScope,
            id,
            LIBRARY_EVENT_TYPES.SAVED_SEARCH_UPDATED,
            updatedRecord,
          );
          return updatedRecord;
        },
      );
      await this.invalidateCache(userId, effectiveProjectId);
      return updated;
    }

    await this.repo.update(userId, id, dto, projectId);
    if (recalculatedCount !== undefined) {
      await this.repo.updateCachedCount(id, recalculatedCount);
    }

    await this.invalidateCache(userId, effectiveProjectId);
    return this.findById(userId, id, projectId);
  }

  async delete(userId: string, id: string, projectId?: string) {
    const existing = await this.findById(userId, id, projectId);
    const effectiveProjectId = normalizeProjectScopeId(
      projectId || existing.projectId,
    );

    if (this.libraryTx) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          await this.repo.softDelete(userId, id, projectId, tx);
          const eventScope = { userId, projectId: effectiveProjectId };
          await helpers.recordTombstone(eventScope, {
            entityType: 'SavedSearch',
            entityId: id,
          });
          await helpers.publishOutbox(
            eventScope,
            id,
            LIBRARY_EVENT_TYPES.SAVED_SEARCH_DELETED,
            {
              id,
              deletedAt: new Date(),
              projectId: effectiveProjectId,
            },
          );
        },
      );
      await this.invalidateCache(userId, effectiveProjectId);
    } else {
      await this.repo.softDelete(userId, id, projectId);
      await this.invalidateCache(userId, effectiveProjectId);
    }

    return { success: true, id };
  }

  async preview(
    userId: string,
    dto: PreviewSavedSearchDto,
    projectId?: string,
  ) {
    if (!dto.conditions) {
      throw new BadRequestException('Conditions must be provided for preview');
    }

    if (dto.scopeOptions && dto.conditions) {
      dto.conditions.scopeOptions =
        dto.conditions.scopeOptions || dto.scopeOptions;
    }

    const effectiveProjectId = projectId || dto.projectId;
    const where = await this.evaluator.compile(
      userId,
      dto.conditions,
      effectiveProjectId,
    );
    const [count, sampleResult] = await Promise.all([
      this.repo.countMatchingItems(where),
      this.repo.findMatchingItems(where, {
        limit: 5,
        sortBy: dto.sortBy as ExecuteSavedSearchOptions['sortBy'],
        sortOrder: dto.sortOrder,
      }),
    ]);

    return {
      count,
      sampleItems: ItemsMapper.toDomainList(sampleResult.items),
    };
  }

  async execute(
    userId: string,
    id: string,
    dto: ExecuteSavedSearchQueryDto,
    projectId?: string,
  ) {
    const effectiveProjectId = projectId || dto.projectId;
    const savedSearch = await this.findById(userId, id, effectiveProjectId);
    const conditions =
      savedSearch.conditions as unknown as SavedSearchConditionGroup;

    const queryProjectId =
      effectiveProjectId || savedSearch.projectId || undefined;
    const where = await this.evaluator.compile(
      userId,
      conditions,
      queryProjectId,
    );

    let rawSortBy = dto.sortBy || savedSearch.sortBy || 'dateAdded';
    if (rawSortBy === 'createdAt') rawSortBy = 'dateAdded';
    if (rawSortBy === 'authors') rawSortBy = 'creator';
    const sortBy = rawSortBy as ExecuteSavedSearchOptions['sortBy'];
    const sortOrder = (dto.sortOrder ||
      savedSearch.sortOrder ||
      'desc') as ExecuteSavedSearchOptions['sortOrder'];

    const [count, results] = await Promise.all([
      this.repo.countMatchingItems(where),
      this.repo.findMatchingItems(where, {
        limit: dto.limit,
        page: dto.page,
        cursor: dto.cursor,
        sortBy,
        sortOrder,
      }),
    ]);

    // Update cached count asynchronously
    this.repo.updateCachedCount(id, count).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to update cached count: ${message}`);
    });

    return {
      savedSearch,
      items: ItemsMapper.toDomainList(results.items),
      meta: {
        totalCount: count,
        cursor: results.nextCursor,
        hasNextPage: results.hasNextPage,
      },
    };
  }
}
