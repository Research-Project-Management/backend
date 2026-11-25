/**
 * citations/services/citation-metrics.service.ts
 * Lightweight in-process observability counters for the Citations subsystem.
 */

import { Injectable } from '@nestjs/common';

export interface CitationMetricsSnapshot {
  indexReads: {
    l1Hits: number;
    l2Hits: number;
    l3Hits: number;
    coldFallbacks: number;
  };
  writes: {
    occRetries: number;
    conflictsDetected: number;
  };
  resolver: {
    cacheHits: number;
    negativeCacheHits: number;
    upstreamCalls: number;
    failures: number;
  };
}

@Injectable()
export class CitationMetricsService {
  private readonly counters: CitationMetricsSnapshot = {
    indexReads: {
      l1Hits: 0,
      l2Hits: 0,
      l3Hits: 0,
      coldFallbacks: 0,
    },
    writes: {
      occRetries: 0,
      conflictsDetected: 0,
    },
    resolver: {
      cacheHits: 0,
      negativeCacheHits: 0,
      upstreamCalls: 0,
      failures: 0,
    },
  };

  public recordIndexHit(tier: 'l1' | 'l2' | 'l3' | 'cold'): void {
    if (tier === 'l1') this.counters.indexReads.l1Hits++;
    else if (tier === 'l2') this.counters.indexReads.l2Hits++;
    else if (tier === 'l3') this.counters.indexReads.l3Hits++;
    else this.counters.indexReads.coldFallbacks++;
  }

  public recordOccRetry(): void {
    this.counters.writes.occRetries++;
  }

  public recordConflicts(count: number): void {
    this.counters.writes.conflictsDetected += count;
  }

  public recordResolver(
    event: 'cache_hit' | 'negative_hit' | 'upstream' | 'failure',
  ): void {
    if (event === 'cache_hit') this.counters.resolver.cacheHits++;
    else if (event === 'negative_hit') this.counters.resolver.negativeCacheHits++;
    else if (event === 'upstream') this.counters.resolver.upstreamCalls++;
    else this.counters.resolver.failures++;
  }

  public getSnapshot(): CitationMetricsSnapshot {
    return {
      indexReads: { ...this.counters.indexReads },
      writes: { ...this.counters.writes },
      resolver: { ...this.counters.resolver },
    };
  }
}


/**
 * citations/services/citation-index.service.ts
 * CQRS Read Model & Event-Driven Cache Projection for Page Citations.
 *
 * Read path: L1 In-Memory LRU (15s) -> L2 Redis Cache (5m) -> Repository fallback.
 * Write invalidation: Subscribes to PageDomainEventBus ('manuscript.document.mutated')
 * so reads avoid hitting Yjs flushDocs() and Docstore on every autocomplete keystroke.
 */

import { Logger, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { PrismaService, RedisCacheService } from '@/core';
import { PageDomainEventBus } from '@/modules/pages/core';
import { CitationsRepository } from '../repositories/citations.repository';
import { CitationEntryDto, ListCitationsResponseDto } from '../dto/citations.dto';

const INDEX_CACHE_PREFIX = 'citation:index:v1';
const L1_TTL_MS = 15_000;
const L2_TTL_SEC = 300;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly metrics?: CitationMetricsService,
  ) {}

  public onModuleInit(): void {
    if (
      this.domainEventBus &&
      typeof this.domainEventBus.subscribe === 'function'
    ) {
      this.domainEventBus.subscribe('manuscript.document.mutated', async (event) => {
        if (event?.projectId) {
          await this.invalidateSpace(event.projectId);
        }
      });
    }
  }

  private buildCacheKey(spaceId: string, pageId?: string): string {
    return `${INDEX_CACHE_PREFIX}:${spaceId}:${pageId ?? 'all'}`;
  }

  public async queryCitations(
    spaceId: string,
    query?: string,
    limit = 500,
    pageId?: string,
  ): Promise<ListCitationsResponseDto> {
    const entries = await this.loadIndexedEntries(spaceId, pageId);
    const term = (query || '').trim().toLowerCase();

    if (!term) {
      return {
        items: entries.slice(0, limit),
        total: entries.length,
      };
    }

    const matches: CitationEntryDto[] = [];
    for (const entry of entries) {
      const matchesKey = entry.key.toLowerCase().includes(term);
      const matchesTitle = (entry.title || '').toLowerCase().includes(term);
      const matchesAuthor = entry.authors.some((a) =>
        a.toLowerCase().includes(term),
      );
      const matchesYear = (entry.year || '').toLowerCase().includes(term);
      if (matchesKey || matchesTitle || matchesAuthor || matchesYear) {
        matches.push(entry);
      }
    }

    return {
      items: matches.slice(0, limit),
      total: matches.length,
    };
  }

  public async invalidateSpace(spaceId: string, pageId?: string): Promise<void> {
    const exactKey = this.buildCacheKey(spaceId, pageId);
    const allKey = this.buildCacheKey(spaceId, undefined);
    this.l1Cache.delete(exactKey);
    this.l1Cache.delete(allKey);

    // Also clear any page-scoped L1 entries for this space
    const prefix = `${INDEX_CACHE_PREFIX}:${spaceId}:`;
    for (const key of this.l1Cache.keys()) {
      if (key.startsWith(prefix)) {
        this.l1Cache.delete(key);
      }
    }

    if (this.redisCache) {
      await Promise.allSettled([
        this.redisCache.del(exactKey),
        this.redisCache.del(allKey),
      ]);
    }

    if (this.prisma?.pageCitationEntry && UUID_REGEX.test(spaceId)) {
      await this.prisma.pageCitationEntry
        .deleteMany({
          where: {
            spaceId,
            ...(pageId && UUID_REGEX.test(pageId) ? { pageId } : {}),
          },
        })
        .catch(() => {});
    }
  }

  private async loadIndexedEntries(
    spaceId: string,
    pageId?: string,
  ): Promise<CitationEntryDto[]> {
    const cacheKey = this.buildCacheKey(spaceId, pageId);

    // 1. L1 LRU Cache
    const l1Hit = this.l1Cache.get(cacheKey);
    if (l1Hit) {
      this.metrics?.recordIndexHit('l1');
      return l1Hit;
    }

    // 2. L2 Redis Cache
    if (this.redisCache) {
      try {
        const l2Hit = await this.redisCache.get<CitationEntryDto[]>(cacheKey);
        if (Array.isArray(l2Hit)) {
          this.metrics?.recordIndexHit('l2');
          this.l1Cache.set(cacheKey, l2Hit);
          return l2Hit;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Redis L2 citation index read failed for ${cacheKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 3. L3 PostgreSQL Read Model (PageCitationEntry) when available
    const l3Entries = await this.readFromPostgres(spaceId, pageId);
    if (l3Entries && l3Entries.length > 0) {
      this.metrics?.recordIndexHit('l3');
      this.l1Cache.set(cacheKey, l3Entries);
      if (this.redisCache) {
        await this.redisCache.set(cacheKey, l3Entries, L2_TTL_SEC).catch(() => {});
      }
      return l3Entries;
    }

    // 4. Cold fallback: collect & parse from Docstore, then warm L1 + L2 + L3
    this.metrics?.recordIndexHit('cold');
    const bibFiles = await this.repository.collectBibFiles(spaceId, pageId);
    const flattened: CitationEntryDto[] = [];
    for (const file of bibFiles) {
      for (const entry of file.entries) {
        flattened.push(entry.toJSON(file.path));
      }
    }

    this.l1Cache.set(cacheKey, flattened);
    if (this.redisCache) {
      await this.redisCache.set(cacheKey, flattened, L2_TTL_SEC).catch(() => {});
    }
    void this.persistToPostgres(spaceId, flattened, pageId);

    return flattened;
  }

  private async readFromPostgres(
    spaceId: string,
    pageId?: string,
  ): Promise<CitationEntryDto[] | null> {
    if (!this.prisma?.pageCitationEntry || !UUID_REGEX.test(spaceId)) {
      return null;
    }
    if (pageId && !UUID_REGEX.test(pageId)) {
      return null;
    }

    try {
      const rows = await this.prisma.pageCitationEntry.findMany({
        where: {
          spaceId,
          ...(pageId ? { pageId } : {}),
        },
        orderBy: { citeKeyLower: 'asc' },
      });
      if (rows.length === 0) return null;

      return rows.map((r) => ({
        key: r.citeKey,
        sourceFile: r.filePath,
        type: r.entryType,
        title: r.title,
        authors: Array.isArray(r.authorsJson)
          ? (r.authorsJson as string[])
          : [],
        ...(r.year ? { year: r.year } : {}),
        ...(r.journal ? { journal: r.journal } : {}),
        ...(r.doi ? { doi: r.doi } : {}),
        ...(r.url ? { url: r.url } : {}),
      }));
    } catch (err: unknown) {
      this.logger.warn(
        `Postgres L3 citation index read failed for space=${spaceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async persistToPostgres(
    spaceId: string,
    entries: CitationEntryDto[],
    pageId?: string,
  ): Promise<void> {
    if (
      !this.prisma?.pageCitationEntry ||
      !UUID_REGEX.test(spaceId) ||
      entries.length === 0
    ) {
      return;
    }
    if (pageId && !UUID_REGEX.test(pageId)) {
      return;
    }

    try {
      const contentHash = createHash('sha256')
        .update(JSON.stringify(entries))
        .digest('hex');

      await this.prisma.$transaction([
        this.prisma.pageCitationEntry.deleteMany({
          where: { spaceId, ...(pageId ? { pageId } : {}) },
        }),
        this.prisma.pageCitationEntry.createMany({
          data: entries.map((e) => ({
            spaceId,
            pageId: pageId ?? null,
            docId: spaceId, // fallback scope key when docId is aggregated
            filePath: e.sourceFile,
            citeKey: e.key,
            citeKeyLower: e.key.toLowerCase(),
            entryType: e.type,
            title: e.title ?? '',
            authorsText: (e.authors || []).join(', '),
            authorsJson: e.authors || [],
            year: e.year ?? null,
            journal: e.journal ?? null,
            doi: e.doi ?? null,
            url: e.url ?? null,
            fieldsJson: {},
            contentHash,
            docVersion: 0,
          })),
          skipDuplicates: true,
        }),
      ]);
    } catch (err: unknown) {
      this.logger.warn(
        `Postgres L3 citation index persist skipped for space=${spaceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

