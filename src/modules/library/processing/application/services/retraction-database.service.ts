import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import {
  RetractionDetails,
  RetractionNature,
  RetractionSource,
} from '../../domain/types/retraction.types';
import * as path from 'path';
import * as fs from 'fs';

export interface RetractionSeedItem {
  doi: string;
  pmid?: string;
  title?: string;
  nature: RetractionNature;
  reason?: string;
  noticeUrl?: string;
  retractionDate?: string;
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

  // Fast In-Memory Indexes for 0ms lookup without DB roundtrip
  private readonly memoryDoiMap = new Map<string, RetractionDetails>();
  private readonly memoryPmidMap = new Map<string, RetractionDetails>();
  // Negative cache: DOIs verified as clean within TTL
  private readonly cleanDoiCache = new Map<string, number>();
  private readonly CLEAN_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    // Non-blocking initialization of seed data and memory cache
    this.initializeDataset().catch((err) => {
      this.logger.warn(
        `Failed to initialize Retraction Watch dataset: ${err.message}`,
      );
    });
  }

  /**
   * Initializes local Retraction Watch dataset and populates the in-memory fast index.
   */
  async initializeDataset(): Promise<void> {
    try {
      await this.seedIfEmpty();
      await this.warmMemoryIndex();
    } catch (err: any) {
      this.logger.warn(`Retraction dataset warmup skipped: ${err?.message}`);
    }
  }

  /**
   * Seeds the local PostgreSQL RetractionRecord table from the bundled Retraction Watch seed file if empty.
   */
  async seedIfEmpty(force = false): Promise<number> {
    try {
      const existingCount = await this.prisma.retractionRecord.count();
      if (existingCount > 0 && !force) {
        this.logger.log(
          `Retraction database already populated (${existingCount} records).`,
        );
        return existingCount;
      }

      const seedPath = path.resolve(
        __dirname,
        '../data/retraction-watch-seed.json',
      );
      if (!fs.existsSync(seedPath)) {
        this.logger.warn(`Retraction seed file not found at ${seedPath}`);
        return existingCount;
      }

      const raw = fs.readFileSync(seedPath, 'utf8');
      const seedData: RetractionSeedItem[] = JSON.parse(raw);

      this.logger.log(
        `Seeding ${seedData.length} Retraction Watch records into PostgreSQL...`,
      );
      let seeded = 0;

      for (const item of seedData) {
        const cleanDoi = item.doi.trim().toLowerCase();
        const cleanPmid = item.pmid?.trim() || null;

        await this.prisma.retractionRecord.upsert({
          where: { doi: cleanDoi },
          create: {
            doi: cleanDoi,
            pmid: cleanPmid,
            isRetracted: true,
            nature: item.nature,
            reason: item.reason || '',
            noticeUrl: item.noticeUrl || null,
            retractionDate: item.retractionDate
              ? new Date(item.retractionDate)
              : null,
            source: item.source || 'retraction_watch',
            rawMetadata: item as any,
          },
          update: {
            pmid: cleanPmid,
            isRetracted: true,
            nature: item.nature,
            reason: item.reason || '',
            noticeUrl: item.noticeUrl || null,
            retractionDate: item.retractionDate
              ? new Date(item.retractionDate)
              : null,
            source: item.source || 'retraction_watch',
            rawMetadata: item as any,
          },
        });
        seeded++;
      }

      this.logger.log(
        `Successfully seeded ${seeded} Retraction Watch records.`,
      );
      return seeded;
    } catch (err: any) {
      this.logger.error(
        `Error seeding Retraction Watch dataset: ${err?.message}`,
      );
      return 0;
    }
  }

  /**
   * Warms up the in-memory fast index from PostgreSQL for instant 0ms lookups.
   */
  async warmMemoryIndex(): Promise<void> {
    try {
      const records = await this.prisma.retractionRecord.findMany({
        where: { isRetracted: true },
        select: {
          doi: true,
          pmid: true,
          nature: true,
          reason: true,
          noticeUrl: true,
          retractionDate: true,
          source: true,
        },
        take: 10000,
      });

      for (const r of records) {
        const details: RetractionDetails = {
          nature: (r.nature as RetractionNature) || 'retraction',
          reason: r.reason || '',
          noticeUrl: r.noticeUrl || undefined,
          date: r.retractionDate ? r.retractionDate.toISOString() : undefined,
          source: (r.source as RetractionSource) || 'retraction_watch',
        };

        if (r.doi) {
          this.memoryDoiMap.set(r.doi.toLowerCase().trim(), details);
        }
        if (r.pmid) {
          this.memoryPmidMap.set(r.pmid.trim(), details);
        }
      }

      this.logger.log(
        `Warmed retraction in-memory index with ${this.memoryDoiMap.size} DOIs and ${this.memoryPmidMap.size} PMIDs.`,
      );
    } catch (err: any) {
      this.logger.warn(`Could not warm memory index: ${err?.message}`);
    }
  }

  /**
   * Fast check for a paper's retraction status.
   * Returns:
   * - RetractionDetails: Confirmed retracted or subject to concern.
   * - false: Confirmed clean (known clean record within TTL).
   * - null: Not found in local database (candidate for title heuristics or online check).
   */
  async checkRetraction(
    doi?: string | null,
    pmid?: string | null,
  ): Promise<RetractionDetails | null | false> {
    const cleanDoi = doi?.trim().toLowerCase();
    const cleanPmid = pmid?.trim();

    // 1. Fast In-Memory Hit (0ms)
    if (cleanDoi && this.memoryDoiMap.has(cleanDoi)) {
      return this.memoryDoiMap.get(cleanDoi)!;
    }
    if (cleanPmid && this.memoryPmidMap.has(cleanPmid)) {
      return this.memoryPmidMap.get(cleanPmid)!;
    }

    // 2. In-Memory Clean Cache Hit (0ms)
    if (cleanDoi) {
      const cleanUntil = this.cleanDoiCache.get(cleanDoi);
      if (cleanUntil && cleanUntil > Date.now()) {
        return false;
      }
    }

    // 3. PostgreSQL RetractionRecord Lookup
    if (cleanDoi || cleanPmid) {
      const record = await this.prisma.retractionRecord.findFirst({
        where: {
          OR: [
            ...(cleanDoi ? [{ doi: cleanDoi }] : []),
            ...(cleanPmid ? [{ pmid: cleanPmid }] : []),
          ],
        },
      });

      if (record) {
        // Handle negative cache: verified clean
        if (!record.isRetracted) {
          if (cleanDoi) {
            this.cleanDoiCache.set(
              cleanDoi,
              Date.now() + this.CLEAN_CACHE_TTL_MS,
            );
          }
          return false;
        }

        const details: RetractionDetails = {
          nature: (record.nature as RetractionNature) || 'retraction',
          reason: record.reason || '',
          noticeUrl: record.noticeUrl || undefined,
          date: record.retractionDate
            ? record.retractionDate.toISOString()
            : undefined,
          source: (record.source as RetractionSource) || 'retraction_watch',
        };

        // Cache in memory for subsequent 0ms hits
        if (cleanDoi) this.memoryDoiMap.set(cleanDoi, details);
        if (cleanPmid) this.memoryPmidMap.set(cleanPmid, details);

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
    const cleanDoi = doi.trim().toLowerCase();
    const cleanPmid = pmid?.trim() || null;

    await this.prisma.retractionRecord.upsert({
      where: { doi: cleanDoi },
      create: {
        doi: cleanDoi,
        pmid: cleanPmid,
        isRetracted: true,
        nature: details.nature,
        reason: details.reason || '',
        noticeUrl: details.noticeUrl || null,
        retractionDate: details.date ? new Date(details.date) : null,
        source: details.source,
        checkedAt: new Date(),
      },
      update: {
        nature: details.nature,
        reason: details.reason || '',
        noticeUrl: details.noticeUrl || null,
        retractionDate: details.date ? new Date(details.date) : null,
        source: details.source,
        checkedAt: new Date(),
      },
    });

    this.memoryDoiMap.set(cleanDoi, details);
    if (cleanPmid) this.memoryPmidMap.set(cleanPmid, details);
    this.cleanDoiCache.delete(cleanDoi);
  }

  /**
   * Records a paper as verified clean (not retracted) to avoid redundant online scans.
   */
  async saveClean(doi: string, pmid?: string | null): Promise<void> {
    const cleanDoi = doi.trim().toLowerCase();
    const cleanPmid = pmid?.trim() || null;

    this.cleanDoiCache.set(cleanDoi, Date.now() + this.CLEAN_CACHE_TTL_MS);

    try {
      await this.prisma.retractionRecord.upsert({
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
    } catch (err: any) {
      this.logger.debug(
        `Could not save clean record for ${cleanDoi}: ${err.message}`,
      );
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
          const cleanDoi = r.doi.trim().toLowerCase();
          const cleanPmid = r.pmid?.trim() || null;

          await this.prisma.retractionRecord.upsert({
            where: { doi: cleanDoi },
            create: {
              doi: cleanDoi,
              pmid: cleanPmid,
              isRetracted: true,
              nature: r.nature,
              reason: r.reason || '',
              noticeUrl: r.noticeUrl || null,
              retractionDate: r.retractionDate
                ? new Date(r.retractionDate)
                : null,
              source: r.source || 'retraction_watch',
              rawMetadata: r as any,
            },
            update: {
              isRetracted: true,
              nature: r.nature,
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
          this.memoryDoiMap.set(cleanDoi, details);
          if (cleanPmid) this.memoryPmidMap.set(cleanPmid, details);
          imported++;
        }),
      );
    }

    return { imported, total: records.length };
  }

  /**
   * Returns statistics about the local retraction database and memory index.
   */
  async getDatabaseStats(): Promise<RetractionDatabaseStats> {
    const [totalRecords, retractedCount, cleanCount, sources] =
      await Promise.all([
        this.prisma.retractionRecord.count(),
        this.prisma.retractionRecord.count({ where: { isRetracted: true } }),
        this.prisma.retractionRecord.count({ where: { isRetracted: false } }),
        this.prisma.retractionRecord.groupBy({
          by: ['source'],
          _count: true,
        }),
      ]);

    const sourceBreakdown: Record<string, number> = {};
    for (const s of sources) {
      sourceBreakdown[s.source] = s._count;
    }

    const latest = await this.prisma.retractionRecord.findFirst({
      orderBy: { checkedAt: 'desc' },
      select: { checkedAt: true },
    });

    return {
      totalRecords,
      retractedCount,
      cleanCount,
      sourceBreakdown,
      inMemoryCached: this.memoryDoiMap.size,
      lastCheckedAt: latest?.checkedAt,
    };
  }
}
