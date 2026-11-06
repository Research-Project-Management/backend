import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisCacheService } from '@/core';
import { SavedSearchesRepository } from '@/modules/library/catalog/repositories/saved-searches.repository';
import { ConditionEvaluatorEngine } from '@/modules/library/catalog/domain/condition-evaluator.policy';
import {
  CreateSavedSearchDto,
  UpdateSavedSearchDto,
  PreviewSavedSearchDto,
  ExecuteSavedSearchQueryDto,
} from '@/modules/library/catalog/dto/collections.dto';
import { ItemsMapper } from '@/modules/library/core';
import {
  SavedSearchConditionGroup,
  ExecuteSavedSearchOptions,
} from '@/modules/library/catalog/types/catalog.types';
import {
  LIBRARY_EVENT_TYPES,
  TransactionHelpers,
  UNIT_OF_WORK,
  IUnitOfWork,
  normalizeProjectScopeId,
  libraryConfig,
  SingleFlightCoalescer,
} from '@/modules/library/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/config/library.config';

@Injectable()
export class SavedSearchesService {
  private readonly logger = new Logger(SavedSearchesService.name);
  private readonly singleFlight = new SingleFlightCoalescer();

  private applyJitter(ttl: number): number {
    return libraryConfig().app.isTest
      ? ttl
      : Math.max(1, Math.floor(ttl * (0.9 + Math.random() * 0.2)));
  }

  constructor(
    private readonly repo: SavedSearchesRepository,
    private readonly evaluator: ConditionEvaluatorEngine,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx?: IUnitOfWork,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateCache(userId: string, projectId?: string | null) {
    if (!this.cache) return;
    const validProjectId = normalizeProjectScopeId(projectId || undefined);
    const scopeKey = validProjectId || userId;
    await this.cache
      .del(LIBRARY_REDIS_KEYS.savedSearches(scopeKey))
      .catch(() => undefined);
  }

  private async compileConditions(
    userId: string,
    group: SavedSearchConditionGroup,
    projectId?: string,
    precomputedDescendantMap?: Map<string, string[]>,
  ): Promise<Prisma.ItemWhereInput> {
    const referencedColIds = this.evaluator.extractReferencedCollectionIds(group);
    const descendantMap =
      precomputedDescendantMap ??
      (referencedColIds.length > 0 && this.repo.findCollectionDescendantsMap
        ? await this.repo.findCollectionDescendantsMap(userId, projectId, referencedColIds)
        : new Map<string, string[]>());
    return this.evaluator.compile(userId, group, projectId, descendantMap);
  }

  async create(userId: string, dto: CreateSavedSearchDto, projectId?: string) {
    const effectiveProjectId = normalizeProjectScopeId(
      projectId || dto.projectId,
    );
    if (
      !dto.conditions ||
      typeof dto.conditions !== 'object' ||
      Array.isArray(dto.conditions)
    ) {
      throw new BadRequestException(
        'Saved search conditions must be a valid condition group object',
      );
    }
    if (dto.scopeOptions && dto.conditions) {
      dto.conditions.scopeOptions =
        dto.conditions.scopeOptions || dto.scopeOptions;
    }
    let where: Prisma.ItemWhereInput;
    try {
      where = await this.compileConditions(
        userId,
        dto.conditions,
        effectiveProjectId,
      );
    } catch (err: unknown) {
      if (err instanceof BadRequestException) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(
        `Invalid saved search conditions: ${message}`,
      );
    }
    let initialCount = 0;
    try {
      if (this.repo.countMatchingItems) {
        initialCount = await this.repo.countMatchingItems(where);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to evaluate initial count: ${message}`);
    }

    if (this.libraryTx) {
      let ranPostCommitHook = false;
      const created = await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          ranPostCommitHook = Boolean(helpers?.onAfterCommit);
          const createdRecord = await this.repo.create(
            userId,
            dto,
            effectiveProjectId,
            tx,
            initialCount,
          );
          if (
            typeof initialCount === 'number' &&
            (createdRecord.cachedCount == null || createdRecord.cachedCount === 0)
          ) {
            createdRecord.cachedCount = initialCount;
            createdRecord.lastEvaluatedAt = new Date();
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
          helpers?.onAfterCommit?.(() =>
            this.invalidateCache(userId, effectiveProjectId),
          );
          return createdRecord;
        },
      );
      if (!ranPostCommitHook) {
        await this.invalidateCache(userId, effectiveProjectId);
      }
      return created;
    }

    const created = await this.repo.create(
      userId,
      dto,
      effectiveProjectId,
      undefined,
      initialCount,
    );
    if (
      typeof initialCount === 'number' &&
      (created.cachedCount == null || created.cachedCount === 0)
    ) {
      created.cachedCount = initialCount;
      created.lastEvaluatedAt = new Date();
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
  >(userId: string, searches: T[], fallbackProjectId?: string): Promise<T[]> {
    if (!Array.isArray(searches) || searches.length === 0) return searches;
    const uninitializedSearches = searches.filter(
      (saved) => saved.cachedCount == null && saved.lastEvaluatedAt == null,
    );
    if (uninitializedSearches.length === 0) return searches;

    const allReferencedColIds = new Set<string>();
    for (const saved of uninitializedSearches) {
      if (
        saved.conditions &&
        typeof saved.conditions === 'object' &&
        !Array.isArray(saved.conditions)
      ) {
        for (const cid of this.evaluator.extractReferencedCollectionIds(
          saved.conditions as SavedSearchConditionGroup,
        )) {
          allReferencedColIds.add(cid);
        }
      }
    }
    const sharedEffectiveProj = normalizeProjectScopeId(
      fallbackProjectId || uninitializedSearches[0]?.projectId || undefined,
    );
    const sharedDescendantMap =
      allReferencedColIds.size > 0 && this.repo.findCollectionDescendantsMap
        ? await this.repo.findCollectionDescendantsMap(
            userId,
            sharedEffectiveProj,
            Array.from(allReferencedColIds),
          )
        : new Map<string, string[]>();

    await Promise.all(
      uninitializedSearches.map(async (saved) => {
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
          const where = await this.compileConditions(
            userId,
            saved.conditions as SavedSearchConditionGroup,
            effectiveProj,
            sharedDescendantMap,
          );
          const count = await this.repo.countMatchingItems(where);
          if (typeof count === 'number') {
            saved.cachedCount = count;
            saved.lastEvaluatedAt = new Date();
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
    const loadSavedSearches = async () => {
      return this.repo.findAll(userId, validProjectId);
    };
    return this.singleFlight.execute(cacheKey, () =>
      this.cache
        ? this.cache.wrap(cacheKey, loadSavedSearches, this.applyJitter(300))
        : loadSavedSearches(),
    );
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
        throw new BadRequestException(
          'Saved search conditions must be a valid condition group object',
        );
      }
      if (dto.scopeOptions) {
        dto.conditions.scopeOptions =
          dto.conditions.scopeOptions || dto.scopeOptions;
      }
      let where: Prisma.ItemWhereInput;
      try {
        where = await this.compileConditions(
          userId,
          dto.conditions,
          effectiveProjectId,
        );
      } catch (err: unknown) {
        if (err instanceof BadRequestException) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new BadRequestException(
          `Invalid saved search conditions: ${message}`,
        );
      }
      try {
        recalculatedCount = await this.repo.countMatchingItems(where);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to update cached count: ${message}`);
      }
    }

    if (this.libraryTx) {
      let ranPostCommitHook = false;
      const updated = await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          ranPostCommitHook = Boolean(helpers?.onAfterCommit);
          await this.repo.update(
            userId,
            id,
            dto,
            projectId,
            tx,
            recalculatedCount,
          );
          const updatedRecord = await this.repo.findById(
            userId,
            id,
            projectId,
            tx,
          );
          if (!updatedRecord) {
            throw new NotFoundException(`Saved search ${id} not found`);
          }
          const eventScope = { userId, projectId: effectiveProjectId };
          await Promise.all([
            helpers.appendChange(eventScope, {
              entityType: 'SavedSearch',
              entityId: id,
              action: 'update',
              version: updatedRecord.version ?? 1,
              data: updatedRecord,
            }),
            helpers.publishOutbox(
              eventScope,
              id,
              LIBRARY_EVENT_TYPES.SAVED_SEARCH_UPDATED,
              updatedRecord,
            ),
          ]);
          helpers?.onAfterCommit?.(() =>
            this.invalidateCache(userId, effectiveProjectId),
          );
          return updatedRecord;
        },
      );
      if (!ranPostCommitHook) {
        await this.invalidateCache(userId, effectiveProjectId);
      }
      return updated;
    }

    await this.repo.update(
      userId,
      id,
      dto,
      projectId,
      undefined,
      recalculatedCount,
    );

    await this.invalidateCache(userId, effectiveProjectId);
    return this.findById(userId, id, projectId);
  }

  async delete(
    userId: string,
    id: string,
    projectId?: string,
    expectedVersion?: number,
  ) {
    const existing = await this.findById(userId, id, projectId);
    const effectiveProjectId = normalizeProjectScopeId(
      projectId || existing.projectId,
    );

    if (this.libraryTx) {
      let ranPostCommitHook = false;
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          ranPostCommitHook = Boolean(helpers?.onAfterCommit);
          await this.repo.softDelete(
            userId,
            id,
            projectId,
            tx,
            expectedVersion,
          );
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
          helpers?.onAfterCommit?.(() =>
            this.invalidateCache(userId, effectiveProjectId),
          );
        },
      );
      if (!ranPostCommitHook) {
        await this.invalidateCache(userId, effectiveProjectId);
      }
    } else {
      await this.repo.softDelete(
        userId,
        id,
        projectId,
        undefined,
        expectedVersion,
      );
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

    const effectiveProjectId = normalizeProjectScopeId(
      projectId || dto.projectId,
    );
    const where = await this.compileConditions(
      userId,
      dto.conditions,
      effectiveProjectId,
    );
    const [count, sampleResult] = await Promise.all([
      this.repo.countMatchingItems(where),
      this.repo.findMatchingItems(
        where,
        {
          limit: 5,
          sortBy: dto.sortBy as ExecuteSavedSearchOptions['sortBy'],
          sortOrder: dto.sortOrder,
          userId,
        },
        userId,
      ),
    ]);

    return {
      count,
      sampleItems: sampleResult.items.map(
        (item) =>
          ItemsMapper.mapFlattenedState(
            item as unknown as Record<string, unknown>,
            userId,
          ) ?? ItemsMapper.toDomain(item),
      ),
    };
  }

  async execute(
    userId: string,
    id: string,
    dto: ExecuteSavedSearchQueryDto,
    projectId?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(
      projectId || dto.projectId,
    );
    const savedSearch = await this.findById(userId, id, effectiveProjectId);
    const conditions =
      savedSearch.conditions as unknown as SavedSearchConditionGroup;

    const queryProjectId = normalizeProjectScopeId(
      effectiveProjectId || savedSearch.projectId,
    );
    const where = await this.compileConditions(
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
      this.repo.findMatchingItems(
        where,
        {
          limit: dto.limit,
          page: dto.page,
          cursor: dto.cursor,
          sortBy,
          sortOrder,
          userId,
        },
        userId,
      ),
    ]);

    // Update cached count asynchronously only if it changed
    if (savedSearch.cachedCount !== count) {
      this.repo.updateCachedCount(id, count).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to update cached count: ${message}`);
      });
    }

    return {
      savedSearch,
      items: results.items.map(
        (item) =>
          ItemsMapper.mapFlattenedState(
            item as unknown as Record<string, unknown>,
            userId,
          ) ?? ItemsMapper.toDomain(item),
      ),
      meta: {
        totalCount: count,
        cursor: results.nextCursor,
        hasNextPage: results.hasNextPage,
      },
    };
  }
}
