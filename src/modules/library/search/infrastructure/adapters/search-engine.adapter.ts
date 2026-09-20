import { Injectable, Logger } from '@nestjs/common';
import {
  ISearchEnginePort,
  SearchResult,
} from '../../domain/ports/search-engine.port';
import { SearchQueryVo } from '../../domain/value-objects/search-query.vo';
import { SearchService } from '../../application/services/search.service';

/**
 * Infrastructure Adapter implementing ISearchEnginePort using SearchService.
 */
@Injectable()
export class SearchEngineAdapter implements ISearchEnginePort {
  private readonly logger = new Logger(SearchEngineAdapter.name);

  constructor(private readonly searchService: SearchService) {}

  async search(
    userId: string,
    query: SearchQueryVo,
    projectId?: string,
  ): Promise<SearchResult> {
    const raw = await this.searchService.search(userId, {
      query: query.query,
      projectId,
      limit: query.limit,
    });

    const hits = (raw?.items || []).map((it: any) => ({
      id: it.id,
      title: it.title,
      doi: it.doi,
      abstract: it.abstract,
      year: it.year,
      score: it.score ?? 1.0,
    }));

    return {
      hits,
      total: hits.length,
    };
  }
}
