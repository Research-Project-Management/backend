import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { RetractionRepository } from '../adapters/retraction.repository';
import { RetractionScannerProvider } from '../adapters/retraction-scanner.provider';
import { RetractionDatabaseService } from './retraction-database.service';

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
  doi?: string | null;
  pmid?: string | null;
  isRetracted?: boolean | null;
  retractionNature?: string | null;
}

@Injectable()
export class RetractionSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetractionSyncService.name);
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: RetractionRepository,
    private readonly scanner: RetractionScannerProvider,
    private readonly retractionDb: RetractionDatabaseService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const intervalHours = Number(
      process.env.RETRACTION_SYNC_INTERVAL_HOURS || 12,
    );
    const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
    this.logger.log(
      `Initializing background Retraction Sync worker (interval: ${intervalHours}h)`,
    );

    // Initial delay of 2 minutes after boot before first background scan
    setTimeout(() => {
      this.syncAllStaleItems().catch((err) => {
        this.logger.warn(
          `Initial background retraction sync error: ${err?.message}`,
        );
      });
    }, 120000);

    this.syncTimer = setInterval(() => {
      this.syncAllStaleItems().catch((err) => {
        this.logger.warn(
          `Periodic background retraction sync error: ${err?.message}`,
        );
      });
    }, intervalMs);
  }

  onModuleDestroy(): void {
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

    const result = await this.processItems(items, concurrency, startTime);

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
            } else {
              skippedUnverified++;
            }
          } catch (err: any) {
            failed++;
            this.logger.warn(
              `Failed to sync retraction status for item ${item.id} (${item.doi || item.pmid || 'no identifier'}): ${err?.message || err}`,
            );
          }
        }),
      );
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
