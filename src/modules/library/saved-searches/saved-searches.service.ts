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

  async create(userId: string, dto: CreateSavedSearchDto) {
    let initialCount = 0;
    try {
      const where = this.evaluator.compile(userId, dto.conditions);
      initialCount = await this.repo.countMatchingItems(where);
    } catch (err: any) {
      this.logger.warn(`Failed to evaluate initial count: ${err?.message}`);
    }

    const created = await this.repo.create(userId, dto);
    if (initialCount > 0) {
      await this.repo.updateCachedCount(created.id, initialCount);
      created.cachedCount = initialCount;
    }
    return created;
  }

  async findAll(userId: string) {
    return this.repo.findAll(userId);
  }

  async findById(userId: string, id: string) {
    const record = await this.repo.findById(userId, id);
    if (!record) {
      throw new NotFoundException(`Saved search ${id} not found`);
    }
    return record;
  }

  async update(userId: string, id: string, dto: UpdateSavedSearchDto) {
    await this.findById(userId, id);
    await this.repo.update(userId, id, dto);

    // If conditions changed, recalculate cached count
    if (dto.conditions) {
      try {
        const where = this.evaluator.compile(userId, dto.conditions);
        const count = await this.repo.countMatchingItems(where);
        await this.repo.updateCachedCount(id, count);
      } catch (err: any) {
        this.logger.warn(`Failed to update cached count: ${err?.message}`);
      }
    }

    return this.findById(userId, id);
  }

  async delete(userId: string, id: string) {
    await this.findById(userId, id);
    await this.repo.softDelete(userId, id);
    return { success: true, id };
  }

  async preview(userId: string, dto: PreviewSavedSearchDto) {
    if (!dto.conditions) {
      throw new BadRequestException('Conditions must be provided for preview');
    }

    const where = this.evaluator.compile(userId, dto.conditions);
    const [count, sampleResult] = await Promise.all([
      this.repo.countMatchingItems(where),
      this.repo.findMatchingItems(where, { limit: 5 }),
    ]);

    return {
      count,
      sampleItems: sampleResult.items,
    };
  }

  async execute(userId: string, id: string, dto: ExecuteSavedSearchQueryDto) {
    const savedSearch = await this.findById(userId, id);
    const conditions = savedSearch.conditions as any;

    const where = this.evaluator.compile(userId, conditions);

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
