import { Injectable, Logger } from '@nestjs/common';
import { ISearchEnginePort, SearchResult } from '../ports/search-engine.port';
import { SearchQueryVo } from '../domain/search-query.vo';
import { SearchService } from '../use-cases/search.service';

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
