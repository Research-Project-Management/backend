import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { SnapshotService } from './snapshot.service';

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_RETENTION_DAYS = 30;

@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(private readonly snapshots: SnapshotService) {}

  public onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.runMaintenance();
    }, MAINTENANCE_INTERVAL_MS);
    this.timer.unref();
  }

  public onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async runMaintenance(
    olderThanDays = DEFAULT_RETENTION_DAYS,
  ): Promise<{ compactedSnapshots: number; deletedOrphanBlobs: number }> {
    if (this.isRunning) {
      return { compactedSnapshots: 0, deletedOrphanBlobs: 0 };
    }
    this.isRunning = true;
    try {
      const result = await this.snapshots.compactAndGc(
        undefined,
        olderThanDays,
      );
      if (result.compactedSnapshots > 0 || result.deletedOrphanBlobs > 0) {
        this.logger.log(
          `History maintenance completed: compacted=${result.compactedSnapshots} snapshots, gc=${result.deletedOrphanBlobs} orphan blobs`,
        );
      }
      return result;
    } catch (err: unknown) {
      this.logger.warn(
        `History maintenance failed: ${(err as Error)?.message || String(err)}`,
      );
      return { compactedSnapshots: 0, deletedOrphanBlobs: 0 };
    } finally {
      this.isRunning = false;
    }
  }
}
