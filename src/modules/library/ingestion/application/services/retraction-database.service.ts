import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RetractionRepository } from '../../infrastructure/repositories/retraction.repository';
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

  constructor(private readonly repo: RetractionRepository) {}

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
      const existingCount = await this.repo.countRetractionRecords();
      if (existingCount > 0 && !force) {
        this.logger.log(
          `Retraction database already populated (${existingCount} records).`,
        );
        return existingCount;
      }

      const candidatePaths = [
        path.resolve(
          __dirname,
          '../../infrastructure/data/retraction-watch-seed.json',
        ),
        path.resolve(__dirname, '../data/retraction-watch-seed.json'),
        path.resolve(
          process.cwd(),
          'src/modules/library/ingestion/infrastructure/data/retraction-watch-seed.json',
        ),
        path.resolve(
          process.cwd(),
          'dist/modules/library/ingestion/infrastructure/data/retraction-watch-seed.json',
        ),
      ];
      const seedPath = candidatePaths.find((p) => fs.existsSync(p));
      if (!seedPath) {
        this.logger.warn(
          `Retraction seed file not found in candidates: ${candidatePaths.join(', ')}`,
        );
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

        await this.repo.upsertRetractionRecord({
          where: { doi: cleanDoi },
          create: {
            doi: cleanDoi,
            pmid: cleanPmid,
            title: item.title || null,
            isRetracted: true,
            nature: item.nature,
            noticeType: item.nature,
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
            title: item.title || null,
            isRetracted: true,
            nature: item.nature,
            noticeType: item.nature,
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
      const records = await this.repo.findRetractionRecordsForMemoryIndex();

      for (const r of records) {
        const details: RetractionDetails = {
          nature:
            ((r as any).nature as RetractionNature) ||
            (r.noticeType as RetractionNature) ||
            'retraction',
          reason: r.reason || '',
          noticeUrl: r.noticeUrl || undefined,
          date: r.retractionDate ? r.retractionDate.toISOString() : undefined,
          source: (r.source as RetractionSource) || 'retraction_watch',
        };

        if (r.doi) this.memoryDoiMap.set(r.doi.toLowerCase().trim(), details);
        if (r.pmid)
          this.memoryPmidMap.set(r.pmid.toLowerCase().trim(), details);
      }

      this.logger.log(
        `Warmed retraction memory cache (${this.memoryDoiMap.size} DOIs, ${this.memoryPmidMap.size} PMIDs).`,
      );
    } catch (err: any) {
      this.logger.warn(`Could not warm retraction index: ${err.message}`);
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
    const cleanDoi = doi ? doi.trim().toLowerCase() : null;
    const cleanPmid = pmid ? pmid.trim().toLowerCase() : null;

    // 1. In-Memory Fast Lookup (0ms)
    if (cleanDoi && this.memoryDoiMap.has(cleanDoi)) {
      return this.memoryDoiMap.get(cleanDoi)!;
    }
    if (cleanPmid && this.memoryPmidMap.has(cleanPmid)) {
      return this.memoryPmidMap.get(cleanPmid)!;
    }

    // 2. Negative Cache Check (verified clean within TTL)
    if (cleanDoi) {
      const cleanUntil = this.cleanDoiCache.get(cleanDoi);
      if (cleanUntil && cleanUntil > Date.now()) {
        return false;
      }
    }

    // 3. PostgreSQL RetractionRecord Lookup
    if (cleanDoi || cleanPmid) {
      const record = await this.repo.findRetractionRecord({
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
          nature: (record.noticeType as RetractionNature) || 'retraction',
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
              rawMetadata: r as any,
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
    const stats = await this.repo.getDatabaseStats();
    return {
      ...stats,
      inMemoryCached: this.memoryDoiMap.size,
    };
  }
}
