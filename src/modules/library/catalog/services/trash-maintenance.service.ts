import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
} from '@nestjs/common';
import { ItemService } from './items.service';
import { shouldRunWorkerConsumers } from '@/core';

export interface TrashMaintenanceResult {
  purgedItems: number;
  purgedNotes: number;
  purgedCollections: number;
  storagePaths: string[];
}

/**
 * TrashMaintenanceService — Background Task Scheduler for Automatic Trash Purge (Parity with Zotero).
 *
 * Automatically purges library items, notes, and collections soft-deleted more than `retentionDays`
 * (default 30 days) along with their unreferenced storage attachments.
 */
@Injectable()
export class TrashMaintenanceService
  implements OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy
{
  private readonly logger = new Logger(TrashMaintenanceService.name);
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isShuttingDown = false;

  // Run maintenance once every 24 hours (86,400,000 ms)
  private static readonly MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  // Initial delay of 60 seconds after bootstrap to avoid competing with boot traffic
  private static readonly INITIAL_BOOT_DELAY_MS = 60 * 1000;
  // Default retention period matching Zotero (30 days)
  public static readonly DEFAULT_RETENTION_DAYS = 30;
  public static readonly DEFAULT_BATCH_LIMIT = 500;

  constructor(private readonly itemService: ItemService) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!shouldRunWorkerConsumers()) {
      this.logger.debug(
        'Skipping Library Trash Maintenance scheduler on non-worker API replica',
      );
      return;
    }

    this.logger.log(
      'Initializing Library Trash Maintenance scheduler (Auto-purge expired trash > 30 days)...',
    );

    // Initial delayed run after startup
    this.scheduleNextRun(TrashMaintenanceService.INITIAL_BOOT_DELAY_MS);
  }

  onApplicationShutdown(): void {
    this.stopScheduler();
  }

  onModuleDestroy(): void {
    this.stopScheduler();
  }

  private stopScheduler(): void {
    this.isShuttingDown = true;
    if (this.maintenanceTimer) {
      clearTimeout(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
  }

  private scheduleNextRun(delayMs: number): void {
    if (this.isShuttingDown) return;

    if (this.maintenanceTimer) {
      clearTimeout(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    this.maintenanceTimer = setTimeout(async () => {
      try {
        await this.runMaintenanceCycle();
      } finally {
        if (!this.isShuttingDown) {
          // Schedule next daily run with jitter (+- 10 minutes) to avoid herd effect
          const jitterMs = (Math.random() - 0.5) * 20 * 60 * 1000;
          const nextInterval = Math.max(
            60 * 60 * 1000,
            TrashMaintenanceService.MAINTENANCE_INTERVAL_MS + jitterMs,
          );
          this.scheduleNextRun(nextInterval);
        }
      }
    }, delayMs);

    if (typeof this.maintenanceTimer === 'object' && 'unref' in this.maintenanceTimer) {
      this.maintenanceTimer.unref();
    }
  }

  /**
   * Executes a single maintenance cycle to purge expired items across all libraries.
   */
  async runMaintenanceCycle(
    retentionDays: number = TrashMaintenanceService.DEFAULT_RETENTION_DAYS,
    limit: number = TrashMaintenanceService.DEFAULT_BATCH_LIMIT,
  ): Promise<TrashMaintenanceResult> {
    if (this.isRunning) {
      this.logger.debug('Maintenance cycle already in progress, skipping overlap');
      return { purgedItems: 0, purgedNotes: 0, purgedCollections: 0, storagePaths: [] };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      this.logger.log(
        `Starting automated trash retention scan (retentionDays: ${retentionDays}, limit: ${limit})...`,
      );

      const result = await this.itemService.purgeExpiredTrash(retentionDays, limit);
      const elapsedMs = Date.now() - startTime;

      if (
        result.purgedItems > 0 ||
        result.purgedNotes > 0 ||
        result.purgedCollections > 0 ||
        result.storagePaths.length > 0
      ) {
        this.logger.log(
          `Trash retention cycle completed in ${elapsedMs}ms: Purged ${result.purgedItems} items, ` +
            `${result.purgedNotes} notes, ${result.purgedCollections} collections, and reclaimed ${result.storagePaths.length} storage files`,
        );
      } else {
        this.logger.debug(
          `Trash retention cycle finished in ${elapsedMs}ms: No expired items found (> ${retentionDays} days)`,
        );
      }

      return {
        purgedItems: result.purgedItems,
        purgedNotes: result.purgedNotes,
        purgedCollections: result.purgedCollections,
        storagePaths: result.storagePaths,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Automated trash retention cycle encountered an error: ${message}`, (err as Error)?.stack);
      return { purgedItems: 0, purgedNotes: 0, purgedCollections: 0, storagePaths: [] };
    } finally {
      this.isRunning = false;
    }
  }
}
