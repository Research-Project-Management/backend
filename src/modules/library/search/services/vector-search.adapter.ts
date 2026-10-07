import { Injectable, Logger } from '@nestjs/common';
import {
  IVectorSearchEnginePort,
  SearchResult,
} from '../types/search-engine.types';

/**
 * Vector / Semantic KNN Search Adapter — implements IVectorSearchEnginePort
 *
 * Current implementation: delegates to Postgres pgvector extension.
 * Scale path: Swap to Qdrant / Weaviate HTTP adapter without touching domain logic.
 */
@Injectable()
export class VectorSearchAdapter implements IVectorSearchEnginePort {
  private readonly logger = new Logger(VectorSearchAdapter.name);

  constructor() {}

  isAvailable(): boolean {
    return false;
  }

  async semanticSearch(
    userId: string,
    queryText: string,
    limit: number = 20,
    projectId?: string,
  ): Promise<SearchResult> {
    this.logger.debug(
      `[VectorSearch] semanticSearch called for user ${userId} query="${queryText}" (vector search engine not enabled)`,
    );
    return { hits: [], total: 0 };
  }
}
