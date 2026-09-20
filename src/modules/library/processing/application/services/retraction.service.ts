import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { RetractionRepository } from '../../infrastructure/repositories/retraction.repository';
import { RetractionScannerProvider } from '../../infrastructure/providers/retraction-scanner.provider';
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
} from '../dtos/retraction.dto';
import {
  RetractionCheckResult,
  RetractionStats,
} from '../../domain/types/retraction.types';

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

    // Do not overwrite manual retraction unless manually unflagged
    if (item.isRetracted && item.retractionNature === 'manual') {
      return {
        itemId,
        isRetracted: true,
        nature: 'manual',
        details: (item.retractionDetails as any) || undefined,
        checkedAt: item.retractionCheckedAt || new Date(),
      };
    }

    const scanResult = await this.scanner.scan(item.doi, item.pmid, item.title);
    const now = new Date();

    if (scanResult) {
      await this.repo.updateItemRetraction(
        itemId,
        true,
        scanResult.nature,
        scanResult,
        now,
      );
      return {
        itemId,
        isRetracted: true,
        nature: scanResult.nature,
        details: scanResult,
        checkedAt: now,
      };
    } else {
      await this.repo.updateItemRetraction(itemId, false, null, null, now);
      return {
        itemId,
        isRetracted: false,
        checkedAt: now,
      };
    }
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
        const result = await this.scanner.scan(item.doi, item.pmid, item.title);
        const now = new Date();
        if (result) {
          if (!item.isRetracted) {
            newlyRetracted++;
          }
          await this.repo.updateItemRetraction(
            item.id,
            true,
            result.nature,
            result,
            now,
          );
        } else {
          await this.repo.updateItemRetraction(item.id, false, null, null, now);
        }
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
