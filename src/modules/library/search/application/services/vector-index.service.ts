import { Injectable, Logger } from '@nestjs/common';
import { SearchRepository } from '../../infrastructure/repositories/search.repository';
import { LocalEmbeddingService } from './local-embedding.service';

export interface ScoredItemMatch {
  itemId: string;
  similarityScore: number;
}

@Injectable()
export class VectorIndexService {
  private readonly logger = new Logger(VectorIndexService.name);

  // In-Memory Vector Index: itemId -> Float32Array
  private readonly memoryIndex = new Map<string, Float32Array>();

  constructor(
    private readonly repo: SearchRepository,
    private readonly embedding: LocalEmbeddingService,
  ) {}

  /**
   * Persists an item's embedding vector in PostgreSQL metadataSourceRecord and in-memory cache.
   */
  async saveVector(
    itemId: string,
    vector: Float32Array,
    modelName = 'all-MiniLM-L6-v2',
  ): Promise<void> {
    const vectorArray = Array.from(vector);

    // 1. Update in-memory index
    this.memoryIndex.set(itemId, vector);

    // 2. Persist to PostgreSQL metadataSourceRecord
    try {
      await this.repo.upsertVectorRecord(itemId, vectorArray, modelName);
    } catch (err: any) {
      this.logger.warn(
        `Could not persist vector for item ${itemId}: ${err?.message}`,
      );
    }
  }

  /**
   * Retrieves an item's embedding vector (checking memory first, then DB).
   */
  async getVector(itemId: string): Promise<Float32Array | null> {
    if (this.memoryIndex.has(itemId)) {
      return this.memoryIndex.get(itemId)!;
    }

    try {
      const record = await this.repo.getVectorRecord(itemId);

      const payload = record?.rawPayload as any;
      if (payload && Array.isArray(payload.vector)) {
        const vec = new Float32Array(payload.vector);
        this.memoryIndex.set(itemId, vec);
        return vec;
      }
    } catch (err: any) {
      this.logger.debug(
        `Could not read vector for item ${itemId}: ${err?.message}`,
      );
    }

    return null;
  }

  /**
   * Batch loads vectors into memory for a set of candidate item IDs.
   */
  async loadVectorsForItems(itemIds: string[]): Promise<void> {
    const missing = itemIds.filter((id) => !this.memoryIndex.has(id));
    if (missing.length === 0) return;

    try {
      const records = await this.repo.findVectorRecords(missing);

      for (const r of records) {
        const payload = r.rawPayload as any;
        if (payload && Array.isArray(payload.vector)) {
          this.memoryIndex.set(r.itemId, new Float32Array(payload.vector));
        }
      }
    } catch (err: any) {
      this.logger.warn(`Batch vector loading error: ${err?.message}`);
    }
  }

  /**
   * Finds the top semantically similar items to a target vector from candidate items.
   */
  async searchSimilar(
    targetVector: Float32Array,
    candidateItemIds: string[],
    limit = 10,
    threshold = 0.25,
  ): Promise<ScoredItemMatch[]> {
    await this.loadVectorsForItems(candidateItemIds);

    const matches: ScoredItemMatch[] = [];

    for (const itemId of candidateItemIds) {
      const itemVec = this.memoryIndex.get(itemId);
      if (!itemVec) continue;

      const score = this.embedding.cosineSimilarity(targetVector, itemVec);
      if (score >= threshold) {
        matches.push({ itemId, similarityScore: score });
      }
    }

    matches.sort((a, b) => b.similarityScore - a.similarityScore);
    return matches.slice(0, limit);
  }

  get indexSize(): number {
    return this.memoryIndex.size;
  }

  clearMemoryIndex(): void {
    this.memoryIndex.clear();
  }
}
