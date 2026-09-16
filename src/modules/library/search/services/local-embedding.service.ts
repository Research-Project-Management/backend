import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';

export const EMBEDDING_DIMENSIONS = 384;

@Injectable()
export class LocalEmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(LocalEmbeddingService.name);
  private pipelineInstance: any = null;
  private isInitializing = false;
  private modelAvailable = false;

  async onModuleInit(): Promise<void> {
    // Lazy non-blocking warmup in background
    this.initPipeline().catch((err) => {
      this.logger.debug(
        `ONNX pipeline initialization deferred/fallback active: ${err?.message}`,
      );
    });
  }

  /**
   * Initializes @xenova/transformers pipeline dynamically.
   */
  private async initPipeline(): Promise<void> {
    if (this.pipelineInstance || this.isInitializing) return;
    this.isInitializing = true;

    try {
      // Dynamic import to support ESM/CommonJS boundary
      const transformers = await import('@xenova/transformers');
      // Configure local cache directory if needed
      transformers.env.allowRemoteModels = true;
      transformers.env.allowLocalModels = true;

      this.pipelineInstance = await transformers.pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
        { quantized: true },
      );
      this.modelAvailable = true;
      this.logger.log('In-process ONNX embedding pipeline (all-MiniLM-L6-v2) ready.');
    } catch (err: any) {
      this.logger.debug(
        `Using built-in deterministic subword vectorizer fallback: ${err?.message}`,
      );
      this.modelAvailable = false;
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Generates a 384-dimensional dense normalized vector for any academic text.
   * If the ONNX model is available, uses MiniLM; otherwise uses built-in deterministic subword vectorizer.
   */
  async embedText(text: string): Promise<Float32Array> {
    if (!text || !text.trim()) {
      return new Float32Array(EMBEDDING_DIMENSIONS);
    }

    const clean = text.trim();

    if (this.pipelineInstance) {
      try {
        const output = await this.pipelineInstance(clean, {
          pooling: 'mean',
          normalize: true,
        });
        const rawData = output.data;
        if (rawData && rawData.length === EMBEDDING_DIMENSIONS) {
          return new Float32Array(rawData);
        }
      } catch (err: any) {
        this.logger.debug(
          `ONNX inference skipped, falling back to deterministic subword vectorizer: ${err?.message}`,
        );
      }
    }

    return this.generateFallbackEmbedding(clean);
  }

  /**
   * Deterministic Subword/N-Gram TF-IDF Dense Vectorizer (384 dimensions, L2 normalized).
   * Generates consistent, high-fidelity embeddings completely offline with zero file dependencies.
   */
  generateFallbackEmbedding(text: string): Float32Array {
    const vector = new Float32Array(EMBEDDING_DIMENSIONS);
    const normalized = text.toLowerCase();

    // 1. Tokenize into words and subword character n-grams (3-grams, 4-grams)
    const words = normalized
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);

    if (words.length === 0) {
      return vector;
    }

    const termFrequencies = new Map<string, number>();

    for (const w of words) {
      termFrequencies.set(w, (termFrequencies.get(w) || 0) + 1);

      // Character n-grams for morphology and typo tolerance
      if (w.length >= 3) {
        for (let i = 0; i <= w.length - 3; i++) {
          const tri = w.substring(i, i + 3);
          termFrequencies.set(tri, (termFrequencies.get(tri) || 0) + 0.5);
        }
      }
      if (w.length >= 4) {
        for (let i = 0; i <= w.length - 4; i++) {
          const quad = w.substring(i, i + 4);
          termFrequencies.set(quad, (termFrequencies.get(quad) || 0) + 0.3);
        }
      }
    }

    // 2. Hash terms into the 384-dimensional vector space using sign hashing
    for (const [term, freq] of termFrequencies.entries()) {
      const hash = createHash('md5').update(term).digest();
      const index = hash.readUInt16BE(0) % EMBEDDING_DIMENSIONS;
      const sign = (hash.readUInt8(2) & 1) === 0 ? 1 : -1;
      const weight = Math.log1p(freq); // log term frequency damping

      vector[index] += sign * weight;
    }

    // 3. Normalize vector to unit length (L2 norm)
    return this.normalizeL2(vector);
  }

  /**
   * Computes the Cosine Similarity between two normalized vectors:
   * cos(u, v) = (u . v) / (||u|| * ||v||)
   * If vectors are already L2 normalized, this equals the dot product.
   */
  cosineSimilarity(
    vecA: Float32Array | number[],
    vecB: Float32Array | number[],
  ): number {
    if (vecA.length !== vecB.length || vecA.length === 0) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      const a = vecA[i];
      const b = vecB[i];
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }

    if (normA === 0 || normB === 0) return 0;
    const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    // Clamp to [-1, 1]
    return Math.max(-1, Math.min(1, similarity));
  }

  /**
   * L2 normalizes a vector in-place or returns a normalized copy.
   */
  normalizeL2(vec: Float32Array | number[]): Float32Array {
    const result = new Float32Array(vec);
    let sumSq = 0;
    for (let i = 0; i < result.length; i++) {
      sumSq += result[i] * result[i];
    }
    const norm = Math.sqrt(sumSq);
    if (norm > 0) {
      for (let i = 0; i < result.length; i++) {
        result[i] /= norm;
      }
    }
    return result;
  }

  get isModelReady(): boolean {
    return this.modelAvailable;
  }
}
