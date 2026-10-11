import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { RetractionRepository } from '../repositories/retraction.repository';
import { RetractionScannerProvider } from '../providers/retraction-scanner.provider';
import {
  RetractionDatabaseService,
  RetractionDatabaseStats,
} from './retraction-database.service';
import {
  RetractionSyncService,
  RetractionSyncResult,
  RetractionSyncOptions,
} from './retraction-sync.service';
import {
  FlagRetractionDto,
  BatchCheckRetractionDto,
} from '../dto/retraction.dto';
import {
  RetractionCheckResult,
  RetractionStats,
} from '../types/retraction.types';

@Injectable()
export class RetractionService {
  private readonly logger = new Logger(RetractionService.name);

  constructor(
    private readonly repo: RetractionRepository,
    private readonly scanner: RetractionScannerProvider,
    private readonly retractionDb: RetractionDatabaseService,
    private readonly syncService: RetractionSyncService,
  ) {}

  async checkItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<RetractionCheckResult> {
    const item = await this.repo.findItemById(userId, itemId, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const meta =
      item.metadata &&
      typeof item.metadata === 'object' &&
      !Array.isArray(item.metadata)
        ? (item.metadata as Record<string, unknown>)
        : {};
    // Do not overwrite manual retraction unless manually unflagged
    if (meta.isRetracted && meta.retractionNature === 'manual') {
      return {
        itemId,
        isRetracted: true,
        nature: 'manual',
        details: (meta.retractionDetails as RetractionDetails) || undefined,
        checkedAt:
          typeof meta.retractionCheckedAt === 'string'
            ? new Date(meta.retractionCheckedAt)
            : new Date(),
      };
    }

    const pmid = typeof meta.pmid === 'string' ? meta.pmid : null;
    const lookup = await this.scanner.lookup(item.doi, pmid);
    const now = new Date();

    if (lookup.status === 'retracted') {
      await this.repo.updateItemRetraction(
        itemId,
        true,
        lookup.details.nature,
        lookup.details,
        now,
      );
      return {
        itemId,
        isRetracted: true,
        status: 'retracted',
        nature: lookup.details.nature,
        details: lookup.details,
        checkedAt: now,
      };
    }

    if (lookup.status === 'clean') {
      await this.repo.updateItemRetraction(itemId, false, null, null, now);
      return {
        itemId,
        isRetracted: false,
        status: 'clean',
        checkedAt: now,
      };
    }

    // Unknown (no DOI/PMID, offline, timeout): keep the stored status and
    // do not bump retractionCheckedAt.
    return {
      itemId,
      isRetracted: Boolean(meta.isRetracted),
      status: 'unknown',
      nature: meta.retractionNature ?? undefined,
      details: meta.retractionDetails || undefined,
      checkedAt: meta.retractionCheckedAt
        ? new Date(meta.retractionCheckedAt)
        : now,
    };
  }

  async checkLibrary(
    userId: string,
    dto?: BatchCheckRetractionDto,
    projectId?: string,
  ): Promise<{ scanned: number; newlyRetracted: number }> {
    const items = await this.repo.findItemsForScan(
      userId,
      dto?.itemIds,
      projectId,
    );
    let newlyRetracted = 0;

    for (const item of items) {
      if (item.isRetracted && item.retractionNature === 'manual') {
        continue;
      }
      try {
        const result = await this.scanner.lookup(item.doi, item.pmid);
        const now = new Date();
        if (result.status === 'retracted') {
          if (!item.isRetracted) {
            newlyRetracted++;
          }
          await this.repo.updateItemRetraction(
            item.id,
            true,
            result.details.nature,
            result.details,
            now,
          );
        } else if (result.status === 'clean') {
          await this.repo.updateItemRetraction(item.id, false, null, null, now);
        }
        // unknown: leave stored status untouched
      } catch (err: any) {
        this.logger.warn(`Error scanning item ${item.id}: ${err?.message}`);
      }
    }

    return {
      scanned: items.length,
      newlyRetracted,
    };
  }

  async setManualFlag(
    userId: string,
    itemId: string,
    dto: FlagRetractionDto,
    projectId?: string,
  ) {
    const item = await this.repo.findItemById(userId, itemId, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const nature = dto.nature || 'manual';
    const details = {
      nature,
      reason: dto.reason?.trim() || 'Flagged manually by researcher',
      noticeUrl: dto.noticeUrl?.trim() || undefined,
      date: dto.date || new Date().toISOString(),
      source: 'manual' as const,
    };

    return this.repo.updateItemRetraction(
      itemId,
      true,
      nature,
      details,
      new Date(),
    );
  }

  async removeManualFlag(userId: string, itemId: string, projectId?: string) {
    const item = await this.repo.findItemById(userId, itemId, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    return this.repo.updateItemRetraction(
      itemId,
      false,
      null,
      null,
      new Date(),
    );
  }

  async getRetractedItems(userId: string, projectId?: string) {
    return this.repo.findRetractedItems(userId, projectId);
  }

  async getStats(userId: string, projectId?: string): Promise<RetractionStats> {
    return this.repo.getStats(userId, projectId);
  }

  async getDatabaseStats(): Promise<RetractionDatabaseStats> {
    return this.retractionDb.getDatabaseStats();
  }

  async seedDatabase(force = false): Promise<{ seeded: number }> {
    const seeded = await this.retractionDb.seedIfEmpty(force);
    return { seeded };
  }

  async syncLibrary(
    userId: string,
    projectId?: string,
    options?: RetractionSyncOptions,
  ): Promise<RetractionSyncResult> {
    return this.syncService.syncStaleLibraryItems(userId, projectId, options);
  }
}
