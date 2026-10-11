import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { SavedSearchesRepository } from '../repositories/saved-searches.repository';
import { ConditionEvaluatorEngine } from '../utils/condition-evaluator.engine';
import {
  CreateSavedSearchDto,
  UpdateSavedSearchDto,
  PreviewSavedSearchDto,
  ExecuteSavedSearchQueryDto,
} from '../dto/saved-search.dto';
import { ItemsMapper } from '../utils/items.mapper';
import {
  SavedSearchConditionGroup,
  ExecuteSavedSearchOptions,
} from '../types/saved-search.types';

@Injectable()
export class SavedSearchesService {
  private readonly logger = new Logger(SavedSearchesService.name);

  constructor(
    private readonly repo: SavedSearchesRepository,
    private readonly evaluator: ConditionEvaluatorEngine,
  ) {}

  async create(userId: string, dto: CreateSavedSearchDto, projectId?: string) {
    const effectiveProjectId = projectId || dto.projectId;
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
    await this.repo.update(userId, id, dto, projectId);

    // If conditions changed, recalculate cached count
    if (dto.conditions) {
      if (dto.scopeOptions) {
        dto.conditions.scopeOptions =
          dto.conditions.scopeOptions || dto.scopeOptions;
      }
      try {
        const effectiveProjectId = projectId || existing.projectId || undefined;
        const where = await this.evaluator.compile(
          userId,
          dto.conditions,
          effectiveProjectId,
        );
        const count = await this.repo.countMatchingItems(where);
        await this.repo.updateCachedCount(id, count);
      } catch (err: any) {
        this.logger.warn(`Failed to update cached count: ${err?.message}`);
      }
    }

    return this.findById(userId, id, projectId);
  }

  async delete(userId: string, id: string, projectId?: string) {
    await this.findById(userId, id, projectId);
    await this.repo.softDelete(userId, id, projectId);
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
      this.repo.findMatchingItems(where, { limit: 5 }),
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
