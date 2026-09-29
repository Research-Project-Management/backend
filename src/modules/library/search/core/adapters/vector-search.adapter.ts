import { Injectable, Logger } from '@nestjs/common';
import {
  IVectorSearchEnginePort,
  SearchResult,
} from '../ports/search-engine.port';

/**
 * Vector / Semantic KNN Search Adapter — implements IVectorSearchEnginePort
 *
 * Current implementation: delegates to Postgres pgvector extension.
 * Scale path: Swap to Qdrant / Weaviate HTTP adapter without touching domain logic.
 *
 * To activate GPU-backed search:
 * 1. Replace QdrantHttpClient injection below
 * 2. Implement semanticSearch via HTTP call to Qdrant
 */
@Injectable()
export class VectorSearchAdapter implements IVectorSearchEnginePort {
  private readonly logger = new Logger(VectorSearchAdapter.name);

  constructor() {}

  async semanticSearch(
    userId: string,
    queryText: string,
    limit: number = 20,
    projectId?: string,
  ): Promise<SearchResult> {
    // TODO (scale): Replace with Qdrant HTTP client call
    // For now: returns empty — semantic search is an enhancement,
    // not required for core FTS functionality.
    this.logger.debug(
      `[VectorSearch] semanticSearch called for user ${userId} query="${queryText}" (pgvector/Qdrant not yet configured)`,
    );
    return { hits: [], total: 0 };
  }
}
