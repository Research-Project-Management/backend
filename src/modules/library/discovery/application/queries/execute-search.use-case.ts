import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  SEARCH_ENGINE_PORT,
  ISearchEnginePort,
  SearchResult,
} from '../../domain/ports/search-engine.port';
import { SearchQueryVo } from '../../domain/value-objects/search-query.vo';

export interface ExecuteSearchQuery {
  userId: string;
  query: string;
  projectId?: string | null;
  limit?: number;
  offset?: number;
  sortBy?: string;
}

@Injectable()
export class ExecuteSearchUseCase {
  private readonly logger = new Logger(ExecuteSearchUseCase.name);

  constructor(
    @Inject(SEARCH_ENGINE_PORT)
    private readonly searchEngine: ISearchEnginePort,
  ) {}

  async execute(queryDto: ExecuteSearchQuery): Promise<SearchResult> {
    this.logger.debug(`Executing search for query: "${queryDto.query}"`);

    const queryVo = SearchQueryVo.create(queryDto.query, {
      limit: queryDto.limit,
      offset: queryDto.offset,
      sortBy: queryDto.sortBy,
    });

    return this.searchEngine.search(
      queryDto.userId,
      queryVo,
      queryDto.projectId ?? undefined,
    );
  }
}
