/**
 * citations/services/index.service.ts
 * L1 In-Memory LRU (15s) -> L2 Redis (5m) -> Docstore fallback cache for listCitations,
 * invalidated via PageDomainEventBus ('manuscript.document.mutated').
 */

import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LRUCache } from 'lru-cache';
import { RedisCacheService } from '@/core';
import { PageDomainEventBus } from '@/modules/pages/core';
import { CitationsRepository } from '../repositories/citations.repository';
import { matchesCitationQuery } from '../domain/bib-entry.domain';
import {
  CitationEntryDto,
  ListCitationsResponseDto,
} from '../dto/citations.dto';

const INDEX_CACHE_PREFIX = 'citation:index:v1';
const L1_TTL_MS = 15_000;
const L2_TTL_SEC = 300;

@Injectable()
export class CitationIndexService implements OnModuleInit {
  private readonly logger = new Logger(CitationIndexService.name);
  private readonly l1Cache = new LRUCache<string, CitationEntryDto[]>({
    max: 500,
    ttl: L1_TTL_MS,
  });

  constructor(
    private readonly repository: CitationsRepository,
    @Optional() private readonly redisCache?: RedisCacheService,
    @Optional() private readonly domainEventBus?: PageDomainEventBus,
  ) {}

  public onModuleInit(): void {
    if (
      this.domainEventBus &&
      typeof this.domainEventBus.subscribe === 'function'
    ) {
      this.domainEventBus.subscribe(
        'manuscript.document.mutated',
        async (event) => {
          if (event?.projectId) {
            await this.invalidateSpace(event.projectId);
          }
        },
      );
    }
  }

  @OnEvent('pages.page.deleted', { async: true })
  public async handlePagePurged(payload?: {
    pageId?: string;
    spaceId?: string;
    projectId?: string;
  }): Promise<void> {
    const scopeId = payload?.spaceId || payload?.projectId || payload?.pageId;
    if (!scopeId) return;
    await this.invalidateSpace(scopeId, payload?.pageId).catch((err) => {
      this.logger.warn(
        `Failed to evict citation cache for purged page ${payload?.pageId ?? scopeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private buildCacheKey(spaceId: string, pageId?: string): string {
    const cleanPageId = pageId?.trim() || 'all';
    return `${INDEX_CACHE_PREFIX}:${spaceId}:${cleanPageId}`;
  }

  public async queryCitations(
    spaceId: string,
    query?: string,
    limit = 500,
    pageId?: string,
  ): Promise<ListCitationsResponseDto> {
    const scopedPageId = pageId?.trim() || undefined;
    const entries = await this.loadIndexedEntries(spaceId, scopedPageId);
    const term = (query || '').trim();

    if (!term) {
      return {
        items: entries.slice(0, limit),
        total: entries.length,
      };
    }

    const matches = entries.filter((entry) => matchesCitationQuery(entry, term));

    return {
      items: matches.slice(0, limit),
      total: matches.length,
    };
  }

  public async invalidateSpace(
    spaceId: string,
    pageId?: string,
  ): Promise<void> {
    const scopedPageId = pageId?.trim() || undefined;
    const allKey = this.buildCacheKey(spaceId, undefined);

    if (scopedPageId) {
      const exactKey = this.buildCacheKey(spaceId, scopedPageId);
      this.l1Cache.delete(exactKey);
      this.l1Cache.delete(allKey);
      if (this.redisCache) {
        await Promise.allSettled([
          this.redisCache.del(exactKey),
          this.redisCache.del(allKey),
        ]);
      }
      return;
    }

    const prefix = `${INDEX_CACHE_PREFIX}:${spaceId}:`;
    for (const key of this.l1Cache.keys()) {
      if (key.startsWith(prefix)) {
        this.l1Cache.delete(key);
      }
    }

    if (this.redisCache) {
      await Promise.allSettled([
        this.redisCache.del(allKey),
        ...(typeof this.redisCache.delPattern === 'function'
          ? [this.redisCache.delPattern(`${prefix}*`)]
          : []),
      ]);
    }
  }

  private async loadIndexedEntries(
    spaceId: string,
    pageId?: string,
  ): Promise<CitationEntryDto[]> {
    const cacheKey = this.buildCacheKey(spaceId, pageId);

    const l1Hit = this.l1Cache.get(cacheKey);
    if (l1Hit) {
      return l1Hit;
    }

    if (this.redisCache) {
      try {
        const l2Hit = await this.redisCache.get<CitationEntryDto[]>(cacheKey);
        if (Array.isArray(l2Hit)) {
          this.l1Cache.set(cacheKey, l2Hit);
          return l2Hit;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Redis L2 citation index read failed for ${cacheKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const bibFiles = await this.repository.collectBibFiles(spaceId, pageId);
    const flattened: CitationEntryDto[] = [];
    for (const file of bibFiles) {
      for (const entry of file.entries) {
        flattened.push(entry.toJSON(file.path));
      }
    }

    this.l1Cache.set(cacheKey, flattened);
    if (this.redisCache) {
      await this.redisCache
        .set(cacheKey, flattened, L2_TTL_SEC)
        .catch(() => {});
    }

    return flattened;
  }
}
