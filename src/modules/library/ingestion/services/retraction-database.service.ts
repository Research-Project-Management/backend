import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisCacheService } from '@/core';
import { RetractionRepository } from '@/modules/library/ingestion/repositories/retraction.repository';
import {
  RetractionDetails,
  RetractionNature,
  RetractionSource,
} from '@/modules/library/ingestion/types/ingestion.types';
import { normalizeDoi, normalizePmid } from '@/modules/library/core';
import { RetractionBloomFilter } from '../domain/retraction-bloom-filter.domain';

export interface RetractionSeedItem {
  doi: string;
  pmid?: string;
  title?: string;
  nature: RetractionNature;
  reason?: string;
  noticeUrl?: string;
  retractionDate?: string;
  retractedAt?: string;
  source: RetractionSource;
}

export interface RetractionDatabaseStats {
  totalRecords: number;
  retractedCount: number;
  cleanCount: number;
  sourceBreakdown: Record<string, number>;
  inMemoryCached: number;
  lastCheckedAt?: Date;
}

@Injectable()
export class RetractionDatabaseService implements OnModuleInit {
  private readonly logger = new Logger(RetractionDatabaseService.name);

  public static readonly MAX_MEMORY_INDEX_ENTRIES = 5000;
  public static readonly MAX_CLEAN_DOI_CACHE = 10000;

  // Fast In-Memory Indexes for 0ms lookup without DB roundtrip
  private readonly memoryDoiMap = new Map<string, RetractionDetails>();
  private readonly memoryPmidMap = new Map<string, RetractionDetails>();
  // High-performance Bitwise Bloom Filter (~70 KB RAM for 60,000 DOIs)
  private readonly bloomFilter = new RetractionBloomFilter(60000, 0.01);
  // Negative cache: DOIs verified as clean within TTL
  private readonly cleanDoiCache = new Map<string, number>();
  private readonly CLEAN_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  private readonly CLEAN_CACHE_TTL_SECONDS = 14 * 24 * 60 * 60;

  constructor(
    private readonly repo: RetractionRepository,
    @Optional() private readonly redisCache?: RedisCacheService,
  ) {}

  private getRedisDoiKey(cleanDoi: string): string {
    return `library:retraction:doi:${cleanDoi}`;
  }

  private setBoundedMap<K, V>(
    map: Map<K, V>,
    key: K,
    value: V,
    max: number,
  ): void {
    if (map.has(key)) {
      map.delete(key);
    } else if (map.size >= max) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) {
        map.delete(oldestKey);
      }
    }
    map.set(key, value);
  }

  private setMemoryDoi(doi: string, details: RetractionDetails): void {
    this.setBoundedMap(
      this.memoryDoiMap,
      doi,
      details,
      RetractionDatabaseService.MAX_MEMORY_INDEX_ENTRIES,
    );
  }

  private setMemoryPmid(pmid: string, details: RetractionDetails): void {
    this.setBoundedMap(
      this.memoryPmidMap,
      pmid,
      details,
      RetractionDatabaseService.MAX_MEMORY_INDEX_ENTRIES,
    );
  }

  private setCleanDoiCache(doi: string, expiresAt: number): void {
    if (this.cleanDoiCache.has(doi)) {
      this.cleanDoiCache.delete(doi);
    } else if (
      this.cleanDoiCache.size >= RetractionDatabaseService.MAX_CLEAN_DOI_CACHE
    ) {
      const now = Date.now();
      for (const [k, exp] of this.cleanDoiCache.entries()) {
        if (exp <= now) {
          this.cleanDoiCache.delete(k);
        }
      }
      if (
        this.cleanDoiCache.size >= RetractionDatabaseService.MAX_CLEAN_DOI_CACHE
      ) {
        const oldestKey = this.cleanDoiCache.keys().next().value;
        if (oldestKey !== undefined) {
          this.cleanDoiCache.delete(oldestKey);
        }
      }
    }
    this.cleanDoiCache.set(doi, expiresAt);
  }

  onModuleInit(): void {
    // Non-blocking initialization of seed data and memory cache
    this.initializeDataset().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to initialize Retraction Watch dataset: ${msg}`);
    });
  }

  /**
   * Initializes local Retraction Watch dataset and populates the in-memory fast index.
   */
  async initializeDataset(): Promise<void> {
    try {
      await this.warmMemoryIndex();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Retraction dataset warmup skipped: ${msg}`);
    }
  }

  /**
   * Warms the in-memory index and returns the current count of retraction records in PostgreSQL.
   */
  async seedIfEmpty(force = false): Promise<number> {
    try {
      if (force || this.memoryDoiMap.size === 0) {
        await this.warmMemoryIndex();
      }
      return await this.repo.countRetractionRecords();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error counting Retraction Watch dataset: ${msg}`);
      return 0;
    }
  }

  /**
   * Warms up the in-memory fast index from PostgreSQL for instant 0ms lookups.
   */
  async warmMemoryIndex(): Promise<void> {
    try {
      const records = await this.repo.findRetractionRecordsForMemoryIndex(
        RetractionDatabaseService.MAX_MEMORY_INDEX_ENTRIES,
      );

      for (const r of records) {
        const details: RetractionDetails = {
          nature:
            (r.nature as RetractionNature) ||
            (r.noticeType as RetractionNature) ||
            'retraction',
          reason: r.reason || '',
          noticeUrl: r.noticeUrl || undefined,
          date: r.retractionDate ? r.retractionDate.toISOString() : undefined,
          source: (r.source as RetractionSource) || 'retraction_watch',
        };

        if (r.doi) this.setMemoryDoi(r.doi.toLowerCase().trim(), details);
        if (r.pmid) this.setMemoryPmid(r.pmid.toLowerCase().trim(), details);
      }

      if (this.repo.findAllRetractionIdentifiersForBloom) {
        const identifiers =
          await this.repo.findAllRetractionIdentifiersForBloom();
        this.bloomFilter.clear();
        for (const item of identifiers) {
          if (item.doi) this.bloomFilter.add(item.doi);
          if (item.pmid) this.bloomFilter.add(item.pmid);
        }
        this.bloomFilter.markReady(true);
        this.logger.log(
          `Populated Retraction Bloom Filter with ${this.bloomFilter.getItemCount()} identifiers (${Math.round(this.bloomFilter.getMemorySizeBytes() / 1024)} KB RAM).`,
        );
      }

      this.logger.log(
        `Warmed retraction memory cache (${this.memoryDoiMap.size} DOIs, ${this.memoryPmidMap.size} PMIDs).`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not warm retraction index: ${msg}`);
    }
  }

  /**
   * Fast lookup: Checks if a paper is retracted.
   * Returns RetractionDetails if retracted, false if explicitly clean, or null if unknown.
   */
  async checkRetraction(
    doi?: string | null,
    pmid?: string | null,
  ): Promise<RetractionDetails | false | null> {
    const cleanDoi = doi ? normalizeDoi(doi) || doi.trim().toLowerCase() : null;
    const cleanPmid = pmid
      ? (normalizePmid(pmid) || pmid.trim()).toLowerCase()
      : null;

    // 1. In-Memory Fast Lookup (0ms) with LRU refresh
    if (cleanDoi && this.memoryDoiMap.has(cleanDoi)) {
      const hit = this.memoryDoiMap.get(cleanDoi)!;
      this.setMemoryDoi(cleanDoi, hit);
      return hit;
    }
    if (cleanPmid && this.memoryPmidMap.has(cleanPmid)) {
      const hit = this.memoryPmidMap.get(cleanPmid)!;
      this.setMemoryPmid(cleanPmid, hit);
      return hit;
    }

    // 1b. Ultra-fast Bloom Filter Pre-Screening (0.001ms, 100% Zero-False-Negative)
    if (this.bloomFilter.isReady()) {
      const doiHit = cleanDoi ? this.bloomFilter.contains(cleanDoi) : false;
      const pmidHit = cleanPmid ? this.bloomFilter.contains(cleanPmid) : false;
      if (!doiHit && !pmidHit) {
        if (cleanDoi) {
          this.setCleanDoiCache(cleanDoi, Date.now() + this.CLEAN_CACHE_TTL_MS);
        }
        return false;
      }
    }

    // 2. Negative Cache Check (verified clean within TTL) & L2 Redis synchronization
    if (cleanDoi) {
      if (this.redisCache?.get) {
        try {
          const redisEntry = await this.redisCache.get<
            RetractionDetails | { __clean: true; expiresAt: number }
          >(this.getRedisDoiKey(cleanDoi));
          if (redisEntry && typeof redisEntry === 'object') {
            if ('__clean' in redisEntry && redisEntry.__clean === true) {
              if (redisEntry.expiresAt > Date.now()) {
                this.setCleanDoiCache(cleanDoi, redisEntry.expiresAt);
                return false;
              }
            } else if ('nature' in redisEntry) {
              this.cleanDoiCache.delete(cleanDoi);
              this.setMemoryDoi(cleanDoi, redisEntry);
              return redisEntry;
            }
          }
        } catch {
          // Non-fatal fallback to in-memory cache
        }
      }

      const cleanUntil = this.cleanDoiCache.get(cleanDoi);
      if (cleanUntil !== undefined) {
        if (cleanUntil > Date.now()) {
          this.setCleanDoiCache(cleanDoi, cleanUntil);
          return false;
        }
        this.cleanDoiCache.delete(cleanDoi);
      }
    }

    // 3. PostgreSQL RetractionRecord Lookup (indexed lookup by DOI / PMID on cache miss)
    if (cleanDoi || cleanPmid) {
      let record =
        cleanDoi && this.repo.findRetractionRecordByDoi
          ? await this.repo.findRetractionRecordByDoi(cleanDoi)
          : null;
      if (!record && cleanPmid && this.repo.findRetractionRecordByPmid) {
        record = await this.repo.findRetractionRecordByPmid(cleanPmid);
      }
      if (!record && this.repo.findRetractionRecord) {
        record = await this.repo.findRetractionRecord({
          OR: [
            ...(cleanDoi ? [{ doi: cleanDoi }] : []),
            ...(cleanPmid ? [{ pmid: cleanPmid }] : []),
          ],
        });
      }

      if (record) {
        // Handle negative cache: verified clean (enforce 14-day TTL)
        if (!record.isRetracted) {
          const checkedAtMs = record.checkedAt
            ? new Date(record.checkedAt).getTime()
            : 0;
          if (
            checkedAtMs > 0 &&
            Date.now() - checkedAtMs > this.CLEAN_CACHE_TTL_MS
          ) {
            return null;
          }
          if (cleanDoi) {
            this.setCleanDoiCache(
              cleanDoi,
              (checkedAtMs > 0 ? checkedAtMs : Date.now()) +
                this.CLEAN_CACHE_TTL_MS,
            );
          }
          return false;
        }

        const details: RetractionDetails = {
          nature: (record.noticeType as RetractionNature) || 'retraction',
          reason: record.reason || '',
          noticeUrl: record.noticeUrl || undefined,
          date: record.retractionDate
            ? record.retractionDate.toISOString()
            : undefined,
          source: (record.source as RetractionSource) || 'retraction_watch',
        };

        // Cache in memory for subsequent 0ms hits
        if (cleanDoi) this.setMemoryDoi(cleanDoi, details);
        if (cleanPmid) this.setMemoryPmid(cleanPmid, details);

        return details;
      }
    }

    return null;
  }

  /**
   * Saves a detected retraction record to PostgreSQL and memory.
   */
  async saveRetraction(
    doi: string,
    details: RetractionDetails,
    pmid?: string | null,
  ): Promise<void> {
    const cleanDoi = normalizeDoi(doi) || doi.trim().toLowerCase();
    const cleanPmid = pmid ? normalizePmid(pmid) || pmid.trim() : null;

    await this.repo.upsertRetractionRecord({
      where: { doi: cleanDoi },
      create: {
        doi: cleanDoi,
        pmid: cleanPmid,
        isRetracted: true,
        nature: details.nature,
        noticeType: details.nature,
        reason: details.reason || '',
        noticeUrl: details.noticeUrl || null,
        retractionDate: details.date ? new Date(details.date) : null,
        source: details.source,
        checkedAt: new Date(),
      },
      update: {
        nature: details.nature,
        noticeType: details.nature,
        reason: details.reason || '',
        noticeUrl: details.noticeUrl || null,
        retractionDate: details.date ? new Date(details.date) : null,
        source: details.source,
        checkedAt: new Date(),
      },
    });

    this.setMemoryDoi(cleanDoi, details);
    if (cleanPmid) this.setMemoryPmid(cleanPmid, details);
    this.cleanDoiCache.delete(cleanDoi);
    await this.redisCache
      ?.set?.(
        this.getRedisDoiKey(cleanDoi),
        details,
        this.CLEAN_CACHE_TTL_SECONDS,
      )
      .catch(() => {});
  }

  /**
   * Records a paper as verified clean (not retracted) to avoid redundant online scans.
   */
  async saveClean(doi: string, pmid?: string | null): Promise<void> {
    const cleanDoi = normalizeDoi(doi) || doi.trim().toLowerCase();
    const cleanPmid = pmid ? normalizePmid(pmid) || pmid.trim() : null;
    const expiresAt = Date.now() + this.CLEAN_CACHE_TTL_MS;

    this.setCleanDoiCache(cleanDoi, expiresAt);
    await this.redisCache
      ?.set?.(
        this.getRedisDoiKey(cleanDoi),
        { __clean: true, expiresAt },
        this.CLEAN_CACHE_TTL_SECONDS,
      )
      .catch(() => {});

    try {
      await this.repo.upsertRetractionRecord({
        where: { doi: cleanDoi },
        create: {
          doi: cleanDoi,
          pmid: cleanPmid,
          isRetracted: false,
          source: 'crossref',
          checkedAt: new Date(),
        },
        update: {
          isRetracted: false,
          checkedAt: new Date(),
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`Could not save clean record for ${cleanDoi}: ${msg}`);
    }
  }

  /**
   * Ingests an array of retraction records (e.g. from an updated dataset dump).
   */
  async importRecords(
    records: RetractionSeedItem[],
  ): Promise<{ imported: number; total: number }> {
    let imported = 0;
    const batchSize = 100;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (r) => {
          if (!r.doi) return;
          const cleanDoi = normalizeDoi(r.doi) || r.doi.trim().toLowerCase();
          const cleanPmid = r.pmid?.trim() || null;

          await this.repo.upsertRetractionRecord({
            where: { doi: cleanDoi },
            create: {
              doi: cleanDoi,
              pmid: cleanPmid,
              title: r.title || null,
              isRetracted: true,
              nature: r.nature,
              noticeType: r.nature,
              reason: r.reason || '',
              noticeUrl: r.noticeUrl || null,
              retractionDate: r.retractionDate
                ? new Date(r.retractionDate)
                : null,
              source: r.source || 'retraction_watch',
              rawMetadata: r as unknown as Prisma.InputJsonValue,
            },
            update: {
              title: r.title || null,
              isRetracted: true,
              nature: r.nature,
              noticeType: r.nature,
              reason: r.reason || '',
              noticeUrl: r.noticeUrl || null,
              retractionDate: r.retractionDate
                ? new Date(r.retractionDate)
                : null,
              source: r.source || 'retraction_watch',
            },
          });

          const details: RetractionDetails = {
            nature: r.nature,
            reason: r.reason,
            noticeUrl: r.noticeUrl,
            date: r.retractionDate,
            source: r.source,
          };
          this.setMemoryDoi(cleanDoi, details);
          if (cleanPmid) this.setMemoryPmid(cleanPmid, details);
          this.cleanDoiCache.delete(cleanDoi);
          await this.redisCache
            ?.set?.(
              this.getRedisDoiKey(cleanDoi),
              details,
              this.CLEAN_CACHE_TTL_SECONDS,
            )
            .catch(() => {});
          imported++;
        }),
      );
    }

    return { imported, total: records.length };
  }

  /**
   * Returns statistics about the local retraction database, memory index, and bloom filter.
   */
  async getDatabaseStats(): Promise<
    RetractionDatabaseStats & {
      bloomFilter?: {
        isReady: boolean;
        itemCount: number;
        memorySizeBytes: number;
      };
    }
  > {
    const stats = await this.repo.getDatabaseStats();
    return {
      ...stats,
      inMemoryCached: this.memoryDoiMap.size,
      bloomFilter: {
        isReady: this.bloomFilter.isReady(),
        itemCount: this.bloomFilter.getItemCount(),
        memorySizeBytes: this.bloomFilter.getMemorySizeBytes(),
      },
    };
  }

  addRetractionToBloom(key: string): void {
    this.bloomFilter.add(key);
  }

  getBloomFilter(): RetractionBloomFilter {
    return this.bloomFilter;
  }
}
