import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { SavedSearchesRepository } from './saved-searches.repository';
import { ConditionEvaluatorEngine } from './engines/condition-evaluator.engine';
import {
  CreateSavedSearchDto,
  UpdateSavedSearchDto,
  PreviewSavedSearchDto,
  ExecuteSavedSearchQueryDto,
} from './dto/saved-search.dto';

@Injectable()
export class SavedSearchesService {
  private readonly logger = new Logger(SavedSearchesService.name);

  constructor(
    private readonly repo: SavedSearchesRepository,
    private readonly evaluator: ConditionEvaluatorEngine,
  ) {}

  async create(userId: string, dto: CreateSavedSearchDto, projectId?: string) {
    const effectiveProjectId = projectId || dto.projectId;
    let initialCount = 0;
    try {
      const where = this.evaluator.compile(
        userId,
        dto.conditions,
        effectiveProjectId,
      );
      initialCount = await this.repo.countMatchingItems(where);
    } catch (err: any) {
      this.logger.warn(`Failed to evaluate initial count: ${err?.message}`);
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
      try {
        const effectiveProjectId = projectId || existing.projectId || undefined;
        const where = this.evaluator.compile(
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

    const effectiveProjectId = projectId || dto.projectId;
    const where = this.evaluator.compile(
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
      sampleItems: sampleResult.items,
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
    const conditions = savedSearch.conditions as any;

    const queryProjectId =
      effectiveProjectId || savedSearch.projectId || undefined;
    const where = this.evaluator.compile(userId, conditions, queryProjectId);

    const sortBy = (dto.sortBy || savedSearch.sortBy || 'dateAdded') as any;
    const sortOrder = (dto.sortOrder || savedSearch.sortOrder || 'desc') as any;

    const [count, results] = await Promise.all([
      this.repo.countMatchingItems(where),
      this.repo.findMatchingItems(where, {
        limit: dto.limit,
        cursor: dto.cursor,
        sortBy,
        sortOrder,
      }),
    ]);

    // Update cached count asynchronously
    this.repo.updateCachedCount(id, count).catch((err) => {
      this.logger.warn(`Failed to update cached count: ${err?.message}`);
    });

    return {
      savedSearch,
      items: results.items,
      meta: {
        totalCount: count,
        cursor: results.nextCursor,
        hasNextPage: results.hasNextPage,
      },
    };
  }
}
