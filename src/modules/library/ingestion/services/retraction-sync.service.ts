import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { RedisCacheService } from '@/core';
import {
  LIBRARY_REDIS_KEYS,
  normalizeProjectScopeId,
} from '@/modules/library/core';
import { libraryConfig } from '@/modules/library/core/config/library.config';
import { RetractionRepository } from '@/modules/library/ingestion/repositories/retraction.repository';
import { RetractionScannerProvider } from '@/modules/library/ingestion/providers/retraction-scanner.provider';

export interface RetractionSyncOptions {
  maxDays?: number;
  limit?: number;
  concurrency?: number;
}

export interface RetractionSyncResult {
  totalEligible: number;
  scanned: number;
  newlyRetracted: number;
  stillClean: number;
  skippedManual: number;
  /** Items with no DOI/PMID or whose lookup could not be completed; status left unchanged. */
  skippedUnverified: number;
  failed: number;
  durationMs: number;
}

interface SyncCandidate {
  id: string;
  userId?: string | null;
  projectId?: string | null;
  doi?: string | null;
  pmid?: string | null;
  isRetracted?: boolean | null;
  retractionNature?: string | null;
}

@Injectable()
export class RetractionSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetractionSyncService.name);
  private initTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: RetractionRepository,
    private readonly scanner: RetractionScannerProvider,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  onModuleInit(): void {
    if (libraryConfig().app.isTest) return;
    const intervalHours = libraryConfig().retraction.syncIntervalHours;
    const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
    this.logger.log(
      `Initializing background Retraction Sync worker (interval: ${intervalHours}h)`,
    );

    // Initial delay of 2 minutes after boot before first background scan
    this.initTimer = setTimeout(() => {
      this.initTimer = null;
      this.syncAllStaleItems().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Initial background retraction sync error: ${msg}`);
      });
    }, 120000);
    this.initTimer.unref();

    this.syncTimer = setInterval(() => {
      this.syncAllStaleItems().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Periodic background retraction sync error: ${msg}`);
      });
    }, intervalMs);
    this.syncTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.initTimer) {
      clearTimeout(this.initTimer);
      this.initTimer = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Periodically scans stale items across all active users and projects.
   */
  async syncAllStaleItems(
    options?: RetractionSyncOptions,
  ): Promise<RetractionSyncResult> {
    const startTime = Date.now();
    const maxDays = options?.maxDays ?? 14;
    const limit = options?.limit ?? 200;
    const concurrency = this.resolveConcurrency(options);

    const staleBefore = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000);
    const items = await this.repo.findGlobalStaleItemsForSync(
      staleBefore,
      limit,
    );

    return this.processItems(items, concurrency, startTime);
  }

  /**
   * Scans stale library items whose retraction status has not been checked
   * within `maxDays` (default 14 days), re-evaluating them against local database & Crossref.
   */
  async syncStaleLibraryItems(
    userId: string,
    projectId?: string,
    options?: RetractionSyncOptions,
  ): Promise<RetractionSyncResult> {
    const startTime = Date.now();
    const maxDays = options?.maxDays ?? 14;
    const limit = options?.limit ?? 100;
    const concurrency = this.resolveConcurrency(options);

    const staleBefore = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000);

    const items = await this.repo.findStaleItemsForSync(
      userId,
      staleBefore,
      projectId,
      limit,
    );

    this.logger.log(
      `Starting retraction delta sync: found ${items.length} eligible stale item(s) (stale threshold: ${maxDays} days, concurrency: ${concurrency})`,
    );

    const scopedItems = items.map((it) => ({
      ...it,
      userId: (it as { userId?: string }).userId || userId,
      projectId: (it as { projectId?: string | null }).projectId ?? projectId,
    }));

    const result = await this.processItems(scopedItems, concurrency, startTime);

    this.logger.log(
      `Retraction delta sync finished in ${result.durationMs}ms: scanned=${result.scanned}, newlyRetracted=${result.newlyRetracted}, clean=${result.stillClean}, skippedManual=${result.skippedManual}, skippedUnverified=${result.skippedUnverified}, failed=${result.failed}`,
    );

    return result;
  }

  private resolveConcurrency(options?: RetractionSyncOptions): number {
    return Math.max(1, Math.min(options?.concurrency ?? 3, 5));
  }

  /**
   * Shared chunked-concurrency processor. Matches by DOI/PMID only; manual
   * flags are preserved and unverifiable items keep their stored status.
   */
  private async processItems(
    items: SyncCandidate[],
    concurrency: number,
    startTime: number,
  ): Promise<RetractionSyncResult> {
    let scanned = 0;
    let newlyRetracted = 0;
    let stillClean = 0;
    let skippedManual = 0;
    let skippedUnverified = 0;
    let failed = 0;
    const updatedItems: SyncCandidate[] = [];

    for (let i = 0; i < items.length; i += concurrency) {
      const chunk = items.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (item) => {
          // Preserve manual override flags
          if (item.isRetracted && item.retractionNature === 'manual') {
            skippedManual++;
            return;
          }

          try {
            const result = await this.scanner.lookup(item.doi, item.pmid);
            const now = new Date();

            if (result.status === 'retracted') {
              if (!item.isRetracted) newlyRetracted++;
              await this.repo.updateItemRetraction(
                item.id,
                true,
                result.details.nature,
                result.details,
                now,
              );
              scanned++;
              updatedItems.push(item);
            } else if (result.status === 'clean') {
              stillClean++;
              await this.repo.updateItemRetraction(
                item.id,
                false,
                null,
                null,
                now,
              );
              scanned++;
              updatedItems.push(item);
            } else {
              skippedUnverified++;
            }
          } catch (err: unknown) {
            failed++;
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Failed to sync retraction status for item ${item.id} (${item.doi || item.pmid || 'no identifier'}): ${msg}`,
            );
          }
        }),
      );
    }

    if (this.cache && updatedItems.length > 0) {
      try {
        const scopesToInvalidate = new Set<string>();
        const tasks: Promise<unknown>[] = [];
        for (const item of updatedItems) {
          tasks.push(
            this.cache.del(LIBRARY_REDIS_KEYS.item(item.id)),
            this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(item.id)),
            this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(item.id)),
          );
          const validProjectId = normalizeProjectScopeId(item.projectId);
          if (validProjectId) {
            scopesToInvalidate.add(validProjectId);
            scopesToInvalidate.add(`proj:${validProjectId}`);
          }
          if (item.userId) {
            scopesToInvalidate.add(item.userId);
          }
        }
        for (const scopeKey of scopesToInvalidate) {
          tasks.push(
            this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(scopeKey)),
            this.cache.del(LIBRARY_REDIS_KEYS.counts(scopeKey)),
          );
        }
        await Promise.all(tasks);
      } catch (cacheErr: unknown) {
        const msg =
          cacheErr instanceof Error ? cacheErr.message : String(cacheErr);
        this.logger.warn(
          `Failed to invalidate Redis caches during retraction sync: ${msg}`,
        );
      }
    }

    return {
      totalEligible: items.length,
      scanned,
      newlyRetracted,
      stillClean,
      skippedManual,
      skippedUnverified,
      failed,
      durationMs: Date.now() - startTime,
    };
  }
}
