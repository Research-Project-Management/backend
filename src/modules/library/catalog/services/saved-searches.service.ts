import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
import { TransactionService } from '@/modules/library/sync';

@Injectable()
export class SavedSearchesService {
  private readonly logger = new Logger(SavedSearchesService.name);

  constructor(
    private readonly repo: SavedSearchesRepository,
    private readonly evaluator: ConditionEvaluatorEngine,
    @Optional() private readonly libraryTx?: TransactionService,
  ) {}

  async create(userId: string, dto: CreateSavedSearchDto, projectId?: string) {
    const effectiveProjectId = normalizeProjectScopeId(
      projectId || dto.projectId,
    );
    if (dto.scopeOptions && dto.conditions) {
      dto.conditions.scopeOptions =
        dto.conditions.scopeOptions || dto.scopeOptions;
    }
    let initialCount = 0;
    try {
      const where = await this.evaluator.compile(
        userId,
        dto.conditions,
        effectiveProjectId,
      );
      initialCount = await this.repo.countMatchingItems(where);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to evaluate initial count: ${message}`);
    }

    if (this.libraryTx) {
      return this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          const created = await this.repo.create(
            userId,
            dto,
            effectiveProjectId,
            tx,
          );
          if (initialCount > 0) {
            await this.repo.updateCachedCount(created.id, initialCount, tx);
            created.cachedCount = initialCount;
          }
          const eventScope = { userId, projectId: effectiveProjectId };
          await helpers.appendChange(eventScope, {
            entityType: 'SavedSearch',
            entityId: created.id,
            action: 'create',
            version: created.version ?? 1,
            data: created,
          });
          await helpers.publishOutbox(
            eventScope,
            created.id,
            LIBRARY_EVENT_TYPES.SAVED_SEARCH_CREATED,
            created,
          );
          return created;
        },
      );
    }

    const created = await this.repo.create(userId, dto, effectiveProjectId);
    if (initialCount > 0) {
      await this.repo.updateCachedCount(created.id, initialCount);
      created.cachedCount = initialCount;
    }
    return created;
  }

  async findAll(userId: string, projectId?: string) {
    return this.repo.findAll(userId, projectId);
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
      if (dto.scopeOptions) {
        dto.conditions.scopeOptions =
          dto.conditions.scopeOptions || dto.scopeOptions;
      }
      try {
        const where = await this.evaluator.compile(
          userId,
          dto.conditions,
          effectiveProjectId,
        );
        recalculatedCount = await this.repo.countMatchingItems(where);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to update cached count: ${message}`);
      }
    }

    if (this.libraryTx) {
      return this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          await this.repo.update(userId, id, dto, projectId, tx);
          if (recalculatedCount !== undefined) {
            await this.repo.updateCachedCount(id, recalculatedCount, tx);
          }
          const updated = await this.repo.findById(userId, id, projectId, tx);
          if (!updated) {
            throw new NotFoundException(`Saved search ${id} not found`);
          }
          const eventScope = { userId, projectId: effectiveProjectId };
          await helpers.appendChange(eventScope, {
            entityType: 'SavedSearch',
            entityId: id,
            action: 'update',
            version: updated.version ?? 1,
            data: updated,
          });
          await helpers.publishOutbox(
            eventScope,
            id,
            LIBRARY_EVENT_TYPES.SAVED_SEARCH_UPDATED,
            updated,
          );
          return updated;
        },
      );
    }

    await this.repo.update(userId, id, dto, projectId);
    if (recalculatedCount !== undefined) {
      await this.repo.updateCachedCount(id, recalculatedCount);
    }

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
    } else {
      await this.repo.softDelete(userId, id, projectId);
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
