import {
  Injectable,
  NotFoundException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { RedisCacheService } from '@/core';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  ITEM_CACHE_INVALIDATOR,
  IItemCacheInvalidator,
} from '@/modules/library/core';
import { invalidateIngestionItemCache } from '@/modules/library/ingestion/repositories/duplicate-merge.repository';
import {
  calculateMetadataQualityScore,
  diagnoseBibliographicQualityIssues,
  QUALITY_RULE_BIT,
} from '@/modules/library/ingestion/domain/metadata.validator';
import { RetractionRepository } from '@/modules/library/ingestion/repositories/retraction.repository';
import { RetractionScannerProvider } from '@/modules/library/ingestion/providers/retraction-scanner.provider';
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
} from '@/modules/library/ingestion/dto/ingestion.dto';
import {
  RetractionCheckResult,
  RetractionStats,
  RetractionDetails,
  RetractionNature,
} from '@/modules/library/ingestion/types/ingestion.types';

export interface CompletenessAnalysis {
  score: number; // 0 - 100
  level: 'complete' | 'adequate' | 'minimal';
  missingKeyFields: string[];
  presentFieldsCount: number;
  totalFieldsCount: number;
}

export interface QualityAuditReport {
  totalItems: number;
  averageQualityScore: number;
  healthReport: {
    missingDoi: number;
    missingAbstract: number;
    missingYear: number;
  };
}

@Injectable()
export class QualityService {
  constructor(
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
  ) {}

  /**
   * Calculates completeness score for an item based on its type definition.
   */
  calculateItemCompleteness(
    item: Record<string, unknown>,
  ): CompletenessAnalysis {
    const itemType =
      typeof item.itemType === 'string'
        ? item.itemType
        : typeof item.type === 'string'
          ? item.type
          : 'journalArticle';
    const fields = this.catalogGateway?.getOrderedFields
      ? this.catalogGateway.getOrderedFields(itemType)
      : [];

    if (!fields || fields.length === 0) {
      return {
        score: 50,
        level: 'adequate',
        missingKeyFields: [],
        presentFieldsCount: 1,
        totalFieldsCount: 1,
      };
    }

    const typeSpecificKeys = (fields as Array<{ key: string }>)
      .filter((f) => !['title', 'date', 'url', 'doi'].includes(f.key))
      .slice(0, 5)
      .map((f) => f.key);

    const evaluation = calculateMetadataQualityScore(item, {
      typeSpecificKeys,
    });

    return {
      score: evaluation.score,
      level: evaluation.level,
      missingKeyFields: evaluation.missingKeyFields,
      presentFieldsCount: evaluation.presentFieldsCount,
      totalFieldsCount: fields.length,
    };
  }

  async getQualityAudit(userId: string, projectId?: string) {
    const items = this.catalogGateway
      ? await this.catalogGateway.findQualityAuditItems(userId, 2000, projectId)
      : [];

    let totalScore = 0;
    let missingDoi = 0;
    let missingAbstract = 0;
    let missingYear = 0;
    let missingAuthors = 0;
    let healthyItems = 0;
    const flaggedItems: Array<{
      itemId: string;
      title: string;
      issues: string[];
    }> = [];

    for (const it of items) {
      const { evaluation, issues, isHealthy } =
        diagnoseBibliographicQualityIssues(
          it as unknown as Record<string, unknown>,
        );

      const issueMask = evaluation.missingIssueMask;
      if (issueMask & QUALITY_RULE_BIT.authors) missingAuthors += 1;
      if (issueMask & QUALITY_RULE_BIT.year) missingYear += 1;
      if (issueMask & QUALITY_RULE_BIT.doi) missingDoi += 1;
      if (issueMask & QUALITY_RULE_BIT.abstract) missingAbstract += 1;

      if (isHealthy) {
        healthyItems += 1;
      } else {
        flaggedItems.push({
          itemId: it.id,
          title: it.title || 'Untitled',
          issues,
        });
      }

      totalScore += evaluation.score;
    }

    const averageQualityScore =
      items.length > 0 ? Math.round(totalScore / items.length) : 100;

    return {
      totalItems: items.length,
      healthyItems,
      averageQualityScore,
      healthScorePercentage: averageQualityScore,
      missingDoiCount: missingDoi,
      missingYearCount: missingYear,
      missingAuthorsCount: missingAuthors,
      missingAbstractCount: missingAbstract,
      missingPdfCount: 0,
      flaggedItems,
      healthReport: {
        missingDoi,
        missingAbstract,
        missingYear,
      },
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
      await this.repo.updateItemRetraction(
        itemId,
        true,
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
        isRetracted: true,
        status: 'retracted',
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
