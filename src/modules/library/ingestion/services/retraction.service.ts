import { Injectable, NotFoundException, Logger, Optional, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisCacheService, shouldRunWorkerConsumers } from '@/core';
import { CATALOG_FACADE, ICatalogFacade, ITEM_CACHE_INVALIDATOR, IItemCacheInvalidator, normalizeProjectScopeId } from '@/modules/library/core';
import { invalidateIngestionItemCache } from '@/modules/library/ingestion/repositories/duplicate-merge.repository';
import { RetractionRepository } from '@/modules/library/ingestion/repositories/retraction.repository';
import { RetractionScannerProvider } from '@/modules/library/ingestion/providers/base-metadata.provider';
import { RetractionDatabaseService, RetractionDatabaseStats } from './retraction-database.service';
import { FlagRetractionDto, BatchCheckRetractionDto } from '@/modules/library/ingestion/dto/ingestion.dto';
import { RetractionCheckResult, RetractionStats, RetractionDetails, RetractionNature } from '@/modules/library/ingestion/types/ingestion.types';
import { libraryConfig } from '@/modules/library/core/config/library.config';
import { RetractionSeederService } from '@/modules/library/ingestion/services/retraction-seeder.service';

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
    @Optional() private readonly seeder?: RetractionSeederService,
    @Optional()
    @Inject(ITEM_CACHE_INVALIDATOR)
    private readonly cacheCoordinator?: IItemCacheInvalidator,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
  ) {}

  onModuleInit(): void {
    if (libraryConfig().app.isTest || !shouldRunWorkerConsumers()) return;
    const intervalHours = libraryConfig().retraction.syncIntervalHours;
    const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
    this.logger.log(
      `Initializing background Retraction Sync worker (interval: ${intervalHours}h)`,
    );

    // Initial delay of 2 minutes after boot before first background scan
    this.initTimer = setTimeout(() => {
      this.initTimer = null;
      const initialTask = libraryConfig().retraction.enableGitlabDump
        ? this.syncDailyRetractionDelta()
        : this.syncAllStaleItems();
      initialTask.catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Initial background retraction sync error: ${msg}`);
      });
    }, 120000);
    this.initTimer.unref();

    this.syncTimer = setInterval(() => {
      this.syncDailyRetractionDelta().catch((err: unknown) => {
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
   * Autonomous daily delta sync:
   * 1. Updates local canonical retraction dataset if seeder is present.
   * 2. Executes targeted Delta Set reconciliation on newly discovered retractions.
   * 3. Scans stale user library items and reconciles against the updated dataset.
   */
  async syncDailyRetractionDelta(
    options?: RetractionSyncOptions,
  ): Promise<RetractionSyncResult> {
    this.logger.log(
      'Executing autonomous daily retraction delta synchronization',
    );
    if (this.seeder) {
      try {
        const seedResult = await this.seeder.seedFromGitlab();
        if (seedResult.deltaDois && seedResult.deltaDois.length > 0) {
          await this.reconcileDeltaRetractions(seedResult.deltaDois);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Automated Crossref dump sync skipped/failed: ${msg}`);
      }
    }
    return this.syncAllStaleItems(options);
  }

  /**
   * Targeted Delta Set Inverted Lookup ($O(|Δ|)): Instantly finds and flags user items
   * that match newly added or updated retractions without scanning the entire library.
   */
  async reconcileDeltaRetractions(
    newlyRetractedDois: string[],
  ): Promise<number> {
    if (!newlyRetractedDois || newlyRetractedDois.length === 0) return 0;
    this.logger.log(
      `Executing targeted Delta Set reconciliation for ${newlyRetractedDois.length} DOIs`,
    );

    const matchingItems = await this.repo.findItemsByDois(newlyRetractedDois);
    if (!matchingItems.length) {
      this.logger.log('Delta Set reconciliation: 0 user items affected.');
      return 0;
    }

    this.logger.warn(
      `Delta Set reconciliation: Found ${matchingItems.length} user item(s) matching new retractions!`,
    );
    let updatedCount = 0;
    const now = new Date();

    for (const item of matchingItems) {
      if (!item.isRetracted && item.doi) {
        const lookupRes = await this.scanner.lookup(item.doi);
        if (lookupRes.status === 'retracted') {
          await this.repo.updateItemRetraction(
            item.id,
            true,
            lookupRes.details.nature,
            lookupRes.details,
            now,
          );
          updatedCount++;
          await invalidateIngestionItemCache({
            itemIds: [item.id],
            userId: (item as { userId?: string | null }).userId,
            projectId: (item as { projectId?: string | null }).projectId,
            cacheCoordinator: this.cacheCoordinator,
            catalogGateway: this.catalogGateway,
            cache: this.cache,
            logger: this.logger,
            contextLabel: 'delta retraction sync',
          });
        }
      }
    }

    this.logger.log(
      `Delta Set reconciliation complete: ${updatedCount} user item(s) updated.`,
    );
    return updatedCount;
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
              scanned++;
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

    if (updatedItems.length > 0) {
      const groupedByScope = new Map<
        string,
        { userId?: string | null; projectId?: string | null; itemIds: string[] }
      >();
      for (const item of updatedItems) {
        const validProjectId = normalizeProjectScopeId(item.projectId);
        const scopeKey = `${item.userId || ''}:${validProjectId || ''}`;
        const existingGroup = groupedByScope.get(scopeKey);
        if (existingGroup) {
          existingGroup.itemIds.push(item.id);
        } else {
          groupedByScope.set(scopeKey, {
            userId: item.userId,
            projectId: validProjectId,
            itemIds: [item.id],
          });
        }
      }
      for (const group of groupedByScope.values()) {
        await invalidateIngestionItemCache({
          itemIds: group.itemIds,
          userId: group.userId,
          projectId: group.projectId,
          cacheCoordinator: this.cacheCoordinator,
          catalogGateway: this.catalogGateway,
          cache: this.cache,
          logger: this.logger,
          contextLabel: 'during retraction sync',
        });
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

@Injectable()
export class RetractionService {
  private readonly logger = new Logger(RetractionService.name);

  constructor(
    private readonly repo: RetractionRepository,
    private readonly scanner: RetractionScannerProvider,
    private readonly retractionDb: RetractionDatabaseService,
    private readonly syncService: RetractionSyncService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional()
    @Inject(ITEM_CACHE_INVALIDATOR)
    private readonly cacheCoordinator?: IItemCacheInvalidator,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
  ) {}

  private async invalidateRetractionCache(
    itemIds: string[],
    userId: string,
    projectId?: string,
  ): Promise<void> {
    await invalidateIngestionItemCache({
      itemIds,
      userId,
      projectId,
      cacheCoordinator: this.cacheCoordinator,
      catalogGateway: this.catalogGateway,
      cache: this.cache,
      logger: this.logger,
      contextLabel: 'retraction cache',
    });
  }

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

    const topPmid = (item as { pmid?: string | null }).pmid;
    const pmid =
      typeof topPmid === 'string' && topPmid.trim()
        ? topPmid
        : typeof meta.pmid === 'string'
          ? meta.pmid
          : null;
    const lookup = await this.scanner.lookup(item.doi, pmid);
    const now = new Date();
    const effectiveProjectId = projectId || item.projectId || undefined;

    if (lookup.status === 'retracted') {
      const isActuallyRetracted =
        lookup.details.nature === 'retraction' ||
        lookup.details.nature === 'Retraction' ||
        lookup.details.nature === 'manual';
      await this.repo.updateItemRetraction(
        itemId,
        isActuallyRetracted,
        lookup.details.nature,
        lookup.details,
        now,
      );
      await this.invalidateRetractionCache(
        [itemId],
        userId,
        effectiveProjectId,
      );
      return {
        itemId,
        isRetracted: isActuallyRetracted,
        status: isActuallyRetracted ? 'retracted' : 'clean',
        nature: lookup.details.nature,
        details: lookup.details,
        checkedAt: now,
      };
    }

    if (lookup.status === 'clean') {
      const wasRetracted = Boolean(
        (item as { isRetracted?: boolean }).isRetracted || meta.isRetracted,
      );
      await this.repo.updateItemRetraction(itemId, false, null, null, now);
      if (wasRetracted) {
        await this.invalidateRetractionCache(
          [itemId],
          userId,
          effectiveProjectId,
        );
      }
      return {
        itemId,
        isRetracted: false,
        status: 'clean',
        checkedAt: now,
      };
    }

    return {
      itemId,
      isRetracted: Boolean(meta.isRetracted),
      status: 'unknown',
      nature:
        typeof meta.retractionNature === 'string'
          ? (meta.retractionNature as RetractionNature)
          : undefined,
      details:
        meta.retractionDetails && typeof meta.retractionDetails === 'object'
          ? (meta.retractionDetails as RetractionDetails)
          : undefined,
      checkedAt:
        typeof meta.retractionCheckedAt === 'string' ||
        typeof meta.retractionCheckedAt === 'number'
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
    const updatedItemIds: string[] = [];

    const scannableItems = items.filter(
      (item) => !(item.isRetracted && item.retractionNature === 'manual'),
    );
    const CONCURRENCY_LIMIT = 5;

    for (let i = 0; i < scannableItems.length; i += CONCURRENCY_LIMIT) {
      const batch = scannableItems.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.all(
        batch.map(async (item) => {
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
              updatedItemIds.push(item.id);
            } else if (result.status === 'clean') {
              await this.repo.updateItemRetraction(
                item.id,
                false,
                null,
                null,
                now,
              );
              updatedItemIds.push(item.id);
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Error scanning item ${item.id}: ${msg}`);
          }
        }),
      );
    }

    if (updatedItemIds.length > 0) {
      await this.invalidateRetractionCache(updatedItemIds, userId, projectId);
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

    const updated = await this.repo.updateItemRetraction(
      itemId,
      true,
      nature,
      details,
      new Date(),
    );

    await this.invalidateRetractionCache(
      [itemId],
      userId,
      projectId || item.projectId || undefined,
    );

    return updated;
  }

  async removeManualFlag(userId: string, itemId: string, projectId?: string) {
    const item = await this.repo.findItemById(userId, itemId, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const updated = await this.repo.updateItemRetraction(
      itemId,
      false,
      null,
      null,
      new Date(),
    );

    await this.invalidateRetractionCache(
      [itemId],
      userId,
      projectId || item.projectId || undefined,
    );

    return updated;
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
