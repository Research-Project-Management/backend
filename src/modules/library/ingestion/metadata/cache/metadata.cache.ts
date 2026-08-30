import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { QueryType, ResolvedMetadata } from '../types/metadata.types';
import { METADATA_POLICY_VERSION } from '../policies/metadata.policy';

const NEGATIVE_SENTINEL = '__metadata_negative__';

@Injectable()
export class MetadataCache {
  private readonly logger = new Logger(MetadataCache.name);

  // Positive TTLs (seconds)
  private readonly TTL_MAP: Record<QueryType, number> = {
    DOI: 7 * 86_400, // 7 days
    ARXIV: 7 * 86_400, // 7 days
    PMID: 7 * 86_400, // 7 days
    ISBN: 14 * 86_400, // 14 days
    URL: 86_400, // 24 hours
    TITLE: 86_400, // 24 hours
  };

  // Negative TTLs (seconds) — short so new preprints/papers are discovered quickly
  private readonly NEGATIVE_TTL_MAP: Record<QueryType, number> = {
    DOI: 3_600, // 1 hour
    ARXIV: 3_600, // 1 hour
    PMID: 3_600, // 1 hour
    ISBN: 7_200, // 2 hours
    URL: 900, // 15 minutes
    TITLE: 900, // 15 minutes
  };

  constructor(@Optional() private readonly redis?: RedisCacheService) {}

  buildKey(queryType: QueryType, canonicalId: string): string {
    const hash = createHash('md5')
      .update(canonicalId.toLowerCase().trim())
      .digest('hex');
    return `metadata:v${METADATA_POLICY_VERSION}:${queryType}:${hash}`;
  }

  async get(key: string): Promise<ResolvedMetadata | null | false> {
    if (!this.redis || !this.redis.isReady()) return null;

    try {
      const raw = await this.redis.get<string | ResolvedMetadata>(key);
      if (raw === null || raw === undefined) return null;

      if (raw === NEGATIVE_SENTINEL) {
        this.logger.debug(`Negative cache HIT: ${key}`);
        return false;
      }

      this.logger.debug(`Cache HIT: ${key}`);
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err: any) {
      this.logger.warn(`Cache GET failed for key "${key}": ${err.message}`);
      return null;
    }
  }

  async set(
    key: string,
    value: ResolvedMetadata,
    queryType: QueryType,
  ): Promise<void> {
    if (!this.redis || !this.redis.isReady()) return;

    const ttl = this.TTL_MAP[queryType] ?? 86_400;
    try {
      await this.redis.set(key, value, ttl);
      this.logger.debug(`Cache SET (TTL=${ttl}s): ${key}`);
    } catch (err: any) {
      this.logger.warn(`Cache SET failed for key "${key}": ${err.message}`);
    }
  }

  async setNegative(key: string, queryType: QueryType): Promise<void> {
    if (!this.redis || !this.redis.isReady()) return;

    const ttl = this.NEGATIVE_TTL_MAP[queryType] ?? 900;
    try {
      await this.redis.set(key, NEGATIVE_SENTINEL, ttl);
      this.logger.debug(`Negative cache SET (TTL=${ttl}s): ${key}`);
    } catch (err: any) {
      this.logger.warn(
        `Negative cache SET failed for key "${key}": ${err.message}`,
      );
    }
  }

  get available(): boolean {
    return Boolean(this.redis && this.redis.isReady());
  }
}
