import { Injectable, Logger } from '@nestjs/common';
import { RetractionRepository } from '../retraction.repository';
import { RetractionScannerProvider } from '../providers/retraction-scanner.provider';
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
  failed: number;
  durationMs: number;
}

@Injectable()
export class RetractionSyncService {
  private readonly logger = new Logger(RetractionSyncService.name);

  constructor(
    private readonly repo: RetractionRepository,
    private readonly scanner: RetractionScannerProvider,
    private readonly retractionDb: RetractionDatabaseService,
  ) {}

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
    const concurrency = Math.max(1, Math.min(options?.concurrency ?? 3, 5));

    const staleBefore = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000);

    const items = await this.repo.findStaleItemsForSync(
      userId,
      staleBefore,
      projectId,
      limit,
    );

    let scanned = 0;
    let newlyRetracted = 0;
    let stillClean = 0;
    let skippedManual = 0;
    let failed = 0;

    this.logger.log(
      `Starting retraction delta sync: found ${items.length} eligible stale item(s) (stale threshold: ${maxDays} days, concurrency: ${concurrency})`,
    );

    // Chunk-based concurrency processing
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
            const scanResult = await this.scanner.scan(
              item.doi,
              item.pmid,
              item.title,
            );
            const now = new Date();

            if (scanResult) {
              if (!item.isRetracted) {
                newlyRetracted++;
              }
              await this.repo.updateItemRetraction(
                item.id,
                true,
                scanResult.nature,
                scanResult,
                now,
              );
            } else {
              stillClean++;
              await this.repo.updateItemRetraction(
                item.id,
                false,
                null,
                null,
                now,
              );
            }
            scanned++;
          } catch (err: any) {
            failed++;
            this.logger.warn(
              `Error during sync scan for item ${item.id} (${item.doi || item.title}): ${err?.message}`,
            );
          }
        }),
      );
    }

    const durationMs = Date.now() - startTime;
    this.logger.log(
      `Retraction delta sync finished in ${durationMs}ms: scanned=${scanned}, newlyRetracted=${newlyRetracted}, clean=${stillClean}, skippedManual=${skippedManual}, failed=${failed}`,
    );

    return {
      totalEligible: items.length,
      scanned,
      newlyRetracted,
      stillClean,
      skippedManual,
      failed,
      durationMs,
    };
  }
}
