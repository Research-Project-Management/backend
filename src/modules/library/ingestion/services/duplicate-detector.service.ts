import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  IItemCacheInvalidator,
  ITEM_CACHE_INVALIDATOR,
  DuplicateCandidateItem,
  normalizeProjectScopeId,
  LIBRARY_REDIS_KEYS,
  LIBRARY_EVENT_TYPES,
  TransactionHelpers,
  UNIT_OF_WORK,
  IUnitOfWork,
  ItemsMapper,
} from '@/modules/library/core';
import { RedisCacheService } from '@/core';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import {
  DuplicateClusterResult,
  DuplicateClusterItem,
} from '@/modules/library/ingestion/types/ingestion.types';
import { UserId, ProjectId } from '@/modules/library/core';
import {
  normalizeTitleForDedupe,
  tokenizeTitleWords,
  extractContributorAuthors,
  generateDedupeBucketKey,
  calculateTitleSimilarity,
  hasConflictingPartOrSupplementMarkers,
  isGenericBoilerplateTitle,
} from '@/modules/library/ingestion/domain/deduplication.domain';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
  ItemProvenancePolicy,
  isPlaceholderItemTitle,
} from '@/modules/library/core';
import {
  RawDuplicateCluster,
  mapCandidateToClusterItem,
  collectExactIdentifierClusters,
  collectFuzzyTitleYearAuthorClusters,
  isPreprintDoiValue,
  isPreprintCandidateItem,
  normalizeNumericLocatorToken,
  normalizeIssueToken,
  isLocalOrElectronicPageRange,
  asMetaObject,
  EffectiveFieldLookupOptions,
  getEffectiveItemField,
} from '@/modules/library/ingestion/domain/duplicate-clustering.helper';
import { invalidateIngestionItemCache } from '@/modules/library/ingestion/repositories/duplicate-merge.repository';

export { asMetaObject, getEffectiveItemField };
export type { EffectiveFieldLookupOptions };

@Injectable()
export class DuplicateDetectorService {
  private readonly logger = new Logger(DuplicateDetectorService.name);

  constructor(
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    private readonly ingestionRepo?: IngestionRepository,
    @Optional()
    @Inject(UNIT_OF_WORK)
    private readonly libraryTx?: IUnitOfWork,
    @Optional()
    private readonly cache?: RedisCacheService,
    @Optional()
    @Inject(ITEM_CACHE_INVALIDATOR)
    private readonly cacheCoordinator?: IItemCacheInvalidator,
  ) {}

  normalizeScopeProjectId(
    rawProjectId?: ProjectId | string | null,
  ): string | undefined {
    return normalizeProjectScopeId(rawProjectId);
  }

  getDismissedPeerIds(item: {
    metadata?: Record<string, unknown> | null;
  }): Set<string> {
    const meta = asMetaObject(item.metadata);
    const list = Array.isArray(meta.dismissedDuplicateIds)
      ? meta.dismissedDuplicateIds
      : [];
    return new Set(
      list.filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    );
  }

  isDismissedPair(
    itemA: { id: string; metadata?: Record<string, unknown> | null },
    itemB: { id: string; metadata?: Record<string, unknown> | null },
  ): boolean {
    return (
      this.getDismissedPeerIds(itemA).has(itemB.id) ||
      this.getDismissedPeerIds(itemB).has(itemA.id)
    );
  }

  resolveItemType(item: {
    itemType?: string | null;
    metadata?: Record<string, unknown> | null;
  }): string {
    if (item.itemType && typeof item.itemType === 'string') {
      return item.itemType;
    }
    const metaType = asMetaObject(item.metadata).itemType;
    return typeof metaType === 'string' && metaType
      ? metaType
      : 'journalArticle';
  }

  isPreprintDoi(doi?: string | null): boolean {
    return isPreprintDoiValue(doi);
  }
  areCompatibleIdentifierDuplicates(
    itemA: DuplicateCandidateItem,
    itemB: DuplicateCandidateItem,
    idType: string,
  ): boolean {
    if (this.isDismissedPair(itemA, itemB)) return false;
    if (hasConflictingPartOrSupplementMarkers(itemA.title, itemB.title)) return false;
    const metaA = asMetaObject(itemA.metadata);
    const metaB = asMetaObject(itemB.metadata);
    const typeA = this.resolveItemType(itemA);
    const typeB = this.resolveItemType(itemB);
    const toStr = (v: unknown) =>
      typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';

    if (idType === 'isbn') {
      const involvesBookChapter =
        typeA === 'bookSection' || typeB === 'bookSection' || typeA === 'chapter' || typeB === 'chapter';
      if (involvesBookChapter) {
        const titleSim = calculateTitleSimilarity(itemA.title, itemB.title);
        if (titleSim < 0.78) return false;
        const pagesA = toStr(metaA.pages).toLowerCase();
        const pagesB = toStr(metaB.pages).toLowerCase();
        if (pagesA && pagesB && pagesA !== pagesB && titleSim < 0.92) return false;
      }
      for (const locatorKey of ['volume', 'edition'] as const) {
        const valA = normalizeNumericLocatorToken(toStr(metaA[locatorKey]));
        const valB = normalizeNumericLocatorToken(toStr(metaB[locatorKey]));
        if (valA && valB && valA !== valB) return false;
      }
      const normA = normalizeTitleForDedupe(itemA.title);
      const normB = normalizeTitleForDedupe(itemB.title);
      if (
        normA && normB &&
        !normA.includes(normB) && !normB.includes(normA) &&
        calculateTitleSimilarity(itemA.title, itemB.title) < 0.5
      ) {
        return false;
      }
    }
    return true;
  }

  hasConflictingTier2BibliographicEvidence(
    itemA: DuplicateCandidateItem,
    itemB: DuplicateCandidateItem,
  ): boolean {
    if (isGenericBoilerplateTitle(itemA.title) || isGenericBoilerplateTitle(itemB.title)) {
      return true;
    }
    const toStr = (v: unknown) =>
      typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    const typeA = this.resolveItemType(itemA);
    const typeB = this.resolveItemType(itemB);
    const metaA = asMetaObject(itemA.metadata);
    const metaB = asMetaObject(itemB.metadata);
    const effDoiA = toStr(getEffectiveItemField(itemA, 'doi', metaA));
    const effDoiB = toStr(getEffectiveItemField(itemB, 'doi', metaB));
    const rawArxivA =
      toStr(getEffectiveItemField(itemA, 'arxivId', metaA)) ||
      (this.isPreprintDoi(effDoiA) && /arxiv\./i.test(effDoiA) ? effDoiA.replace(/^.*arxiv\./i, '') : '');
    const rawArxivB =
      toStr(getEffectiveItemField(itemB, 'arxivId', metaB)) ||
      (this.isPreprintDoi(effDoiB) && /arxiv\./i.test(effDoiB) ? effDoiB.replace(/^.*arxiv\./i, '') : '');
    const normArxivA = rawArxivA ? normalizeArxivId(rawArxivA, { stripVersion: true }) : undefined;
    const normArxivB = rawArxivB ? normalizeArxivId(rawArxivB, { stripVersion: true }) : undefined;
    if (normArxivA && normArxivB && normArxivA !== normArxivB) return true;

    const rawPmidA = toStr(getEffectiveItemField(itemA, 'pmid', metaA));
    const rawPmidB = toStr(getEffectiveItemField(itemB, 'pmid', metaB));
    const normPmidA = rawPmidA ? normalizePmid(rawPmidA) : undefined;
    const normPmidB = rawPmidB ? normalizePmid(rawPmidB) : undefined;
    if (normPmidA && normPmidB && normPmidA !== normPmidB) return true;

    const normDoiA = normalizeDoi(effDoiA);
    const normDoiB = normalizeDoi(effDoiB);
    const isPreprintA = Boolean(
      normArxivA || this.isPreprintDoi(effDoiA) || typeA === 'preprint' || isPreprintCandidateItem(itemA),
    );
    const isPreprintB = Boolean(
      normArxivB || this.isPreprintDoi(effDoiB) || typeB === 'preprint' || isPreprintCandidateItem(itemB),
    );
    if (normDoiA && normDoiB && normDoiA !== normDoiB && !isPreprintA && !isPreprintB) {
      return true;
    }
    if (isPreprintA || isPreprintB) return false;

    const pagesA = toStr(metaA.pages);
    const pagesB = toStr(metaB.pages);
    if (pagesA && pagesB && !isLocalOrElectronicPageRange(pagesA) && !isLocalOrElectronicPageRange(pagesB)) {
      const startPageA = pagesA.match(/\d+/)?.[0];
      const startPageB = pagesB.match(/\d+/)?.[0];
      if (startPageA && startPageB && parseInt(startPageA, 10) !== parseInt(startPageB, 10)) {
        return true;
      }
    }
    const issueA = normalizeIssueToken(toStr(metaA.issue));
    const issueB = normalizeIssueToken(toStr(metaB.issue));
    return Boolean(issueA && issueB && issueA !== issueB);
  }

  private static readonly MASTER_TYPE_WEIGHT: Readonly<Record<string, number>> =
    {
      journalArticle: 50,
      book: 40,
      bookSection: 40,
      conferencePaper: 40,
      thesis: 40,
      patent: 40,
      report: 40,
      preprint: 10,
      manuscript: 10,
      workingPaper: 10,
      webpage: 10,
    };

  private scoreMasterCandidate(item: DuplicateCandidateItem): number {
    const type = this.resolveItemType(item);
    const meta = asMetaObject(item.metadata);
    return (
      (DuplicateDetectorService.MASTER_TYPE_WEIGHT[type] ?? 25) +
      (item.doi ? (this.isPreprintDoi(item.doi) ? 10 : 30) : 0) +
      (getEffectiveItemField(item, 'publicationTitle', meta) ? 10 : 0) +
      (getEffectiveItemField(item, 'abstract', meta) ? 10 : 0) +
      (item.year ? 5 : 0) +
      Math.min(10, Object.keys(meta).length) +
      (isPlaceholderItemTitle(item.title) || meta.isFilenameTitle === true
        ? -25
        : 0)
    );
  }

  computeRecommendedMasterId(group: DuplicateCandidateItem[]): string {
    if (group.length === 0) return '';
    let bestId = group[0].id;
    let bestScore = -Infinity;

    for (const item of group) {
      const score = this.scoreMasterCandidate(item);
      if (score > bestScore) {
        bestScore = score;
        bestId = item.id;
      }
    }

    return bestId;
  }

  async dismissDuplicates(
    userId: UserId | string,
    itemIds: string[],
    projectId?: ProjectId | string,
  ): Promise<{ dismissed: boolean; itemIds: string[] }> {
    const uniqueIds = Array.from(
      new Set(
        (itemIds || []).filter((id) => typeof id === 'string' && id.trim()),
      ),
    );
    if (uniqueIds.length < 2) {
      throw new BadRequestException(
        'At least 2 itemIds are required to dismiss duplicates',
      );
    }

    const effectiveProjectId = this.normalizeScopeProjectId(projectId);
    const items = this.catalogGateway
      ? await this.catalogGateway.findByIds(
          String(userId),
          uniqueIds,
          effectiveProjectId,
        )
      : [];

    if (items.length !== uniqueIds.length) {
      throw new NotFoundException(
        'One or more items do not exist or belong to another scope',
      );
    }

    for (const item of items) {
      const itemScope = this.normalizeScopeProjectId(
        (item as { projectId?: string | null }).projectId,
      );
      if (itemScope !== effectiveProjectId) {
        throw new BadRequestException(
          'Cannot dismiss duplicates across different library scopes',
        );
      }
    }

    if (this.libraryTx) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers?: TransactionHelpers) => {
          const eventScope = {
            userId: String(userId),
            projectId: effectiveProjectId,
          };
          const updatedResults = await Promise.all(
            items.map(async (item) => {
              const meta = { ...asMetaObject(item.metadata) };
              const existingDismissed = Array.isArray(meta.dismissedDuplicateIds)
                ? (meta.dismissedDuplicateIds as string[])
                : [];
              const peerIds = uniqueIds.filter((id) => id !== item.id);
              meta.dismissedDuplicateIds = Array.from(
                new Set([...existingDismissed, ...peerIds]),
              );

              const updated = await tx.item.update({
                where: { id: item.id },
                data: {
                  metadata: meta as Prisma.InputJsonValue,
                  version: { increment: 1 },
                },
                include: {
                  contributors: { orderBy: { orderIndex: 'asc' } },
                  collectionItems: { include: { collection: true } },
                  itemTags: { include: { tag: true } },
                  notesList: { where: { deletedAt: null } },
                  attachments: { include: { revisions: true } },
                  identifiers: true,
                  states: { where: { userId: String(userId) }, take: 1 },
                },
              });

              return { item, updated, dismissedDuplicateIds: meta.dismissedDuplicateIds };
            }),
          );

          if (helpers && updatedResults.length > 0) {
            const changeEntries = updatedResults.map(({ item, updated }) => {
              const itemRecord = item as unknown as Record<string, unknown>;
              const updatedRecord = (updated ?? {}) as Record<string, unknown>;
              const domainMapped = ItemsMapper.toDomain(
                { ...itemRecord, ...updatedRecord },
                String(userId),
              ) as unknown as Record<string, unknown>;
              return {
                entityType: 'Item' as const,
                entityId: item.id,
                action: 'update' as const,
                version: updated.version,
                data: {
                  ...itemRecord,
                  ...domainMapped,
                  metadata: (updatedRecord.metadata ??
                    domainMapped.metadata) as Record<string, unknown>,
                },
              };
            });
            const outboxEvents = updatedResults.map(
              ({ item, dismissedDuplicateIds }) => ({
                aggregateId: item.id,
                eventType: LIBRARY_EVENT_TYPES.ITEM_UPDATED,
                payload: {
                  itemId: item.id,
                  userId: String(userId),
                  projectId: effectiveProjectId,
                  dismissedDuplicateIds,
                },
              }),
            );

            if (helpers.appendChangesBatch) {
              await helpers.appendChangesBatch(eventScope, changeEntries);
            } else {
              for (const entry of changeEntries) {
                await helpers.appendChange(eventScope, entry);
              }
            }

            if (helpers.publishOutboxBatch) {
              await helpers.publishOutboxBatch(eventScope, outboxEvents);
            } else {
              for (const ev of outboxEvents) {
                await helpers.publishOutbox(
                  eventScope,
                  ev.aggregateId,
                  ev.eventType,
                  ev.payload,
                );
              }
            }
          }
        },
      );
    }

    await invalidateIngestionItemCache({
      itemIds: uniqueIds,
      userId: String(userId),
      projectId: effectiveProjectId,
      cacheCoordinator: this.cacheCoordinator,
      catalogGateway: this.catalogGateway,
      cache: this.cache,
      logger: this.logger,
      contextLabel: 'after dismissing duplicates',
    });

    return { dismissed: true, itemIds: uniqueIds };
  }

  async detectDuplicates(
    userId: UserId | string,
    projectId?: ProjectId | string,
  ): Promise<DuplicateClusterResult[]> {
    const effectiveProjectId = this.normalizeScopeProjectId(projectId);
    const items = this.catalogGateway
      ? await this.catalogGateway.findDuplicateCandidateItems(
          userId,
          undefined,
          effectiveProjectId,
        )
      : [];

    const candidateById = new Map<string, DuplicateCandidateItem>(
      items.map((it) => [it.id, it]),
    );
    const rawClusters: RawDuplicateCluster[] = [];
    const groupedItemIds = new Set<string>();

    // Tier 0: Ingestion-Suspect Pairs
    if (this.ingestionRepo) {
      try {
        const suspects =
          await this.ingestionRepo.findIngestionDuplicateSuspects({
            userId: String(userId),
            projectId: effectiveProjectId,
          });

        for (const suspect of suspects) {
          const itemA = candidateById.get(suspect.createdItemId);
          const itemB = candidateById.get(suspect.targetItemId);
          if (
            itemA &&
            itemB &&
            !groupedItemIds.has(itemA.id) &&
            !groupedItemIds.has(itemB.id) &&
            !this.isDismissedPair(itemA, itemB)
          ) {
            groupedItemIds.add(itemA.id);
            groupedItemIds.add(itemB.id);
            const pair = [itemA, itemB];
            rawClusters.push({
              clusterId: `ingest-${suspect.runId.substring(0, 8)}-${itemA.id.substring(0, 8)}`,
              matchReason: 'INGESTION_SUSPECT',
              confidence: suspect.confidence,
              recommendedMasterId: this.computeRecommendedMasterId(pair),
              rawGroup: pair,
            });
          }
        }
      } catch (err) {
        this.logger.warn(
          `Could not load ingestion duplicate suspects: ${(err as Error).message}`,
        );
      }
    }

    // Tier 1: Exact Academic Identifiers (DOI, arXiv, PMID, ISBN)
    collectExactIdentifierClusters({
      items,
      groupedItemIds,
      rawClusters,
      getEffectiveItemField: (it, f) => getEffectiveItemField(it, f),
      areCompatibleIdentifierDuplicates: (a, b, idType) =>
        this.areCompatibleIdentifierDuplicates(a, b, idType),
      computeRecommendedMasterId: (grp) => this.computeRecommendedMasterId(grp),
      isDismissedPair: (a, b) => this.isDismissedPair(a, b),
    });

    // Tier 2: Fuzzy Title + Year (+/-1) + First Author
    collectFuzzyTitleYearAuthorClusters({
      items,
      groupedItemIds,
      rawClusters,
      isDismissedPair: (a, b) => this.isDismissedPair(a, b),
      hasConflictingTier2BibliographicEvidence: (a, b) =>
        this.hasConflictingTier2BibliographicEvidence(a, b),
      computeRecommendedMasterId: (grp) => this.computeRecommendedMasterId(grp),
    });

    const hydratedRawById = new Map<string, Record<string, unknown>>();
    if (
      rawClusters.length > 0 &&
      groupedItemIds.size > 0 &&
      this.catalogGateway?.findByIds
    ) {
      try {
        const fullRawItems = await this.catalogGateway.findByIds(
          String(userId),
          Array.from(groupedItemIds),
          effectiveProjectId,
        );
        if (Array.isArray(fullRawItems)) {
          for (const raw of fullRawItems) {
            if (raw && raw.id) {
              hydratedRawById.set(raw.id, raw);
            }
          }
        }
      } catch (err) {
        this.logger.warn(
          `Batch hydration of duplicate cluster items skipped: ${(err as Error).message}`,
        );
      }
    }

    return rawClusters.map((rc) => {
      const mappedItems = rc.rawGroup.map((m) =>
        mapCandidateToClusterItem(
          m,
          (it) =>
            this.resolveItemType(
              it as { itemType?: string | null; metadata?: Record<string, unknown> | null },
            ),
          hydratedRawById.get(m.id),
        ),
      );
      return {
        clusterId: rc.clusterId,
        matchReason: rc.matchReason,
        confidence: rc.confidence,
        recommendedMasterId: rc.recommendedMasterId,
        items: mappedItems,
      };
    });
  }

  async checkDuplicates(
    scope: { userId: string; projectId?: string | null },
    candidate: {
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      title?: string | null;
    },
  ) {
    if (!this.catalogGateway?.findMatchCandidates) {
      return { matchType: 'NO_MATCH', exactMatch: null, candidateItems: [] };
    }
    const cleanDoi = candidate.doi ? normalizeDoi(candidate.doi) || candidate.doi.trim() : undefined;
    const cleanArxiv = candidate.arxivId ? normalizeArxivId(candidate.arxivId) || candidate.arxivId.trim() : undefined;
    const cleanPmid = candidate.pmid ? normalizePmid(candidate.pmid) || candidate.pmid.trim() : undefined;
    const cleanIsbn = candidate.isbn ? normalizeIsbn(candidate.isbn) || candidate.isbn.trim() : undefined;
    const proposedTitle = candidate.title?.trim();
    const significantWords =
      proposedTitle && proposedTitle.length > 5
        ? tokenizeTitleWords(proposedTitle).filter((w) => w.length >= 3).slice(0, 3)
        : [];

    return this.catalogGateway.findMatchCandidates(scope, {
      doi: cleanDoi, arxivId: cleanArxiv, pmid: cleanPmid, isbn: cleanIsbn,
      titleWords: significantWords, titlePrefix: proposedTitle,
    });
  }
}
