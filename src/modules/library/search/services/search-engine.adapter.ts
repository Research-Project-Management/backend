import { Injectable, Logger } from '@nestjs/common';
import { ISearchEnginePort, SearchResult } from '../types/search-engine.types';
import { SearchQueryVo } from '../types/search-query.vo';
import { SearchService } from './search.service';

/**
 * Postgres Full-Text Search (FTS) Adapter — implements ISearchEnginePort
 *
 * Uses Postgres tsvector columns and GIN indexes on read replicas.
 * Scale path: Point to a Postgres read replica connection pool.
 */
@Injectable()
export class PostgresFtsAdapter implements ISearchEnginePort {
  private readonly logger = new Logger(PostgresFtsAdapter.name);

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

    const hits = (raw?.items || []).map(
      (item: {
        id: string;
        title: string;
        doi?: string | null;
        abstract?: string | null;
        year?: number | null;
        score?: number;
      }) => ({
        id: item.id,
        title: item.title,
        doi: item.doi,
        abstract: item.abstract,
        year: item.year,
        score: item.score ?? 1.0,
      }),
    );

    return {
      hits,
      total: hits.length,
    };
  }
}
