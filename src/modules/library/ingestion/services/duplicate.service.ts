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
  TransactionService,
  TransactionHelpers,
  LIBRARY_EVENT_TYPES,
} from '@/modules/library/shared-kernel';
import { DuplicateCandidateItem, ItemsMapper } from '@/modules/library/catalog';
import {
  CATALOG_GATEWAY_PORT,
  ICatalogGatewayPort,
} from '@/modules/library/ingestion/types/catalog-gateway.types';
import {
  EXTRACTION_GATEWAY_PORT,
  IExtractionGatewayPort,
} from '@/modules/library/ingestion/types/extraction-gateway.types';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { MergeDuplicatesDto } from '@/modules/library/ingestion/dto/curation.dto';
import {
  DuplicateClusterResult,
  DuplicateClusterItem,
  PrismaMergeAuditTrail,
  ALLOWED_MERGE_METADATA_FIELDS,
} from '@/modules/library/ingestion/types/curation.types';
import {
  UserId,
  ProjectId,
} from '@/modules/library/shared-kernel/core/types/branded.types';
import {
  normalizeTitleForDedupe,
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
} from '@/modules/library/ingestion/domain/metadata.domain';

interface ContributorShape {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  name?: string;
  orderIndex?: number;
}

const SYSTEM_RESERVED_MERGE_KEYS = new Set([
  'id',
  'userId',
  'projectId',
  'deletedAt',
  'createdAt',
  'updatedAt',
  'version',
]);

const TOP_LEVEL_ITEM_COLUMNS = new Set([
  'title',
  'itemType',
  'year',
  'citationKey',
  'doi',
  'publicationTitle',
  'abstract',
  'url',
  'isRetracted',
]);

const IDENTIFIER_META_KEYS = [
  'arxivId',
  'pmid',
  'pmcid',
  'isbn',
  'issn',
] as const;

const RETRACTION_SURVIVAL_KEYS = [
  'retraction',
  'retractionDate',
  'retractionNature',
  'retractionReasons',
  'retractionNoticeDoi',
  'retractionSource',
] as const;

function asMetaObject(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

function getEffectiveItemField(
  item: unknown,
  field: string,
  metaOverride?: Record<string, unknown>,
): unknown {
  const rec = asMetaObject(item);
  const topVal = rec[field];
  if (topVal !== undefined && topVal !== null && topVal !== '') {
    return topVal;
  }
  const meta = metaOverride || asMetaObject(rec.metadata);
  const metaVal = meta[field];
  return metaVal !== undefined && metaVal !== null && metaVal !== ''
    ? metaVal
    : undefined;
}

@Injectable()
export class DuplicateService {
  private readonly logger = new Logger(DuplicateService.name);

  constructor(
    private readonly libraryTx: TransactionService,
    @Optional()
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway?: ICatalogGatewayPort,
    @Optional()
    @Inject(EXTRACTION_GATEWAY_PORT)
    private readonly extractionGateway?: IExtractionGatewayPort,
    @Optional()
    private readonly ingestionRepo?: IngestionRepository,
  ) {}

  private normalizeScopeProjectId(
    rawProjectId?: ProjectId | string | null,
  ): string | undefined {
    if (!rawProjectId || typeof rawProjectId !== 'string') return undefined;
    const trimmed = rawProjectId.trim();
    if (
      !trimmed ||
      ['user', 'me', 'personal'].includes(trimmed.toLowerCase())
    ) {
      return undefined;
    }
    return trimmed;
  }

  private getDismissedPeerIds(item: {
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

  private isDismissedPair(
    itemA: { id: string; metadata?: Record<string, unknown> | null },
    itemB: { id: string; metadata?: Record<string, unknown> | null },
  ): boolean {
    return (
      this.getDismissedPeerIds(itemA).has(itemB.id) ||
      this.getDismissedPeerIds(itemB).has(itemA.id)
    );
  }

  private resolveItemType(item: {
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

  private isPreprintDoi(doi?: string | null): boolean {
    if (!doi) return false;
    const norm = (normalizeDoi(doi) || doi).toLowerCase().trim();
    return (
      norm.startsWith('10.48550/arxiv.') ||
      norm.startsWith('10.1101/') ||
      norm.startsWith('10.21203/') ||
      norm.startsWith('10.26434/') ||
      norm.includes('/arxiv.')
    );
  }

  private areCompatibleIdentifierDuplicates(
    itemA: DuplicateCandidateItem,
    itemB: DuplicateCandidateItem,
    idType: string,
  ): boolean {
    if (this.isDismissedPair(itemA, itemB)) return false;
    if (hasConflictingPartOrSupplementMarkers(itemA.title, itemB.title)) {
      return false;
    }

    const metaA = asMetaObject(itemA.metadata);
    const metaB = asMetaObject(itemB.metadata);
    const typeA = this.resolveItemType(itemA);
    const typeB = this.resolveItemType(itemB);

    const involvesBookChapter =
      typeA === 'bookSection' ||
      typeB === 'bookSection' ||
      typeA === 'chapter' ||
      typeB === 'chapter';
    if (involvesBookChapter) {
      const titleSim = calculateTitleSimilarity(itemA.title, itemB.title);
      if (titleSim < 0.78) return false;
      const pagesA = String(metaA.pages ?? '')
        .trim()
        .toLowerCase();
      const pagesB = String(metaB.pages ?? '')
        .trim()
        .toLowerCase();
      if (pagesA && pagesB && pagesA !== pagesB && titleSim < 0.92) {
        return false;
      }
    }

    if (idType === 'isbn') {
      for (const locatorKey of ['volume', 'edition'] as const) {
        const valA = String(metaA[locatorKey] ?? '')
          .trim()
          .toLowerCase();
        const valB = String(metaB[locatorKey] ?? '')
          .trim()
          .toLowerCase();
        if (valA && valB && valA !== valB) return false;
      }
      const normA = normalizeTitleForDedupe(itemA.title);
      const normB = normalizeTitleForDedupe(itemB.title);
      if (
        normA &&
        normB &&
        !normA.includes(normB) &&
        !normB.includes(normA) &&
        calculateTitleSimilarity(itemA.title, itemB.title) < 0.5
      ) {
        return false;
      }
    }

    return true;
  }

  private hasConflictingTier2BibliographicEvidence(
    itemA: DuplicateCandidateItem,
    itemB: DuplicateCandidateItem,
  ): boolean {
    if (
      isGenericBoilerplateTitle(itemA.title) ||
      isGenericBoilerplateTitle(itemB.title)
    ) {
      return true;
    }

    const typeA = this.resolveItemType(itemA);
    const typeB = this.resolveItemType(itemB);
    const metaA = asMetaObject(itemA.metadata);
    const metaB = asMetaObject(itemB.metadata);

    const isPreprintEvolution =
      Boolean(
        itemA.arxivId ||
        metaA.arxivId ||
        this.isPreprintDoi(itemA.doi) ||
        typeA === 'preprint',
      ) ||
      Boolean(
        itemB.arxivId ||
        metaB.arxivId ||
        this.isPreprintDoi(itemB.doi) ||
        typeB === 'preprint',
      );

    if (isPreprintEvolution) return false;

    const normDoiA = normalizeDoi(itemA.doi);
    const normDoiB = normalizeDoi(itemB.doi);
    if (normDoiA && normDoiB && normDoiA !== normDoiB) return true;

    const pagesA = String(metaA.pages ?? '').trim();
    const pagesB = String(metaB.pages ?? '').trim();
    if (pagesA && pagesB) {
      const startPageA = pagesA.match(/\d+/)?.[0];
      const startPageB = pagesB.match(/\d+/)?.[0];
      if (startPageA && startPageB && startPageA !== startPageB) return true;
    }

    const issueA = String(metaA.issue ?? '')
      .trim()
      .toLowerCase();
    const issueB = String(metaB.issue ?? '')
      .trim()
      .toLowerCase();
    return Boolean(issueA && issueB && issueA !== issueB);
  }

  private computeRecommendedMasterId(group: DuplicateCandidateItem[]): string {
    if (group.length === 0) return '';
    let bestId = group[0].id;
    let bestScore = -Infinity;

    for (const item of group) {
      const type = this.resolveItemType(item);
      const meta = asMetaObject(item.metadata);
      let score =
        type === 'journalArticle'
          ? 50
          : [
                'book',
                'bookSection',
                'conferencePaper',
                'thesis',
                'patent',
                'report',
              ].includes(type)
            ? 40
            : ['preprint', 'manuscript', 'workingPaper', 'webpage'].includes(
                  type,
                )
              ? 10
              : 25;

      if (item.doi) {
        score += this.isPreprintDoi(item.doi) ? 10 : 30;
      }
      if (getEffectiveItemField(item, 'publicationTitle', meta)) score += 10;
      if (getEffectiveItemField(item, 'abstract', meta)) score += 10;
      if (item.year) score += 5;
      score += Math.min(10, Object.keys(meta).length);

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

    await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient) => {
        for (const item of items) {
          const meta = { ...asMetaObject(item.metadata) };
          const existingDismissed = Array.isArray(meta.dismissedDuplicateIds)
            ? (meta.dismissedDuplicateIds as string[])
            : [];
          const peerIds = uniqueIds.filter((id) => id !== item.id);
          meta.dismissedDuplicateIds = Array.from(
            new Set([...existingDismissed, ...peerIds]),
          );

          if (typeof tx.item?.update === 'function') {
            await tx.item.update({
              where: { id: item.id },
              data: {
                metadata: meta as Prisma.InputJsonValue,
                version: { increment: 1 },
              },
            });
          }
        }
      },
    );

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

    const getItemAuthors = (
      item: DuplicateCandidateItem & { authors?: string[] },
    ): string[] => {
      const fromContributors = extractContributorAuthors(item);
      return fromContributors.length > 0
        ? fromContributors
        : item.authors || [];
    };

    const buildClusterItemList = (
      group: DuplicateCandidateItem[],
    ): DuplicateClusterItem[] =>
      group.map((m) => {
        const domainProjected = ItemsMapper.toDomain({
          ...m,
          itemType: this.resolveItemType(m),
          authors: getItemAuthors(m),
        }) as unknown as DuplicateClusterItem;
        return {
          ...domainProjected,
          id: m.id,
          title: m.title,
          itemType: this.resolveItemType(m),
          doi: (domainProjected.doi || m.doi) ?? undefined,
          year: domainProjected.year ?? m.year ?? undefined,
          authors:
            Array.isArray(domainProjected.authors) &&
            domainProjected.authors.length > 0
              ? domainProjected.authors
              : getItemAuthors(m),
          citationKey:
            (domainProjected.citationKey || m.citationKey) ?? undefined,
        };
      });

    const clusters: DuplicateClusterResult[] = [];
    const groupedItemIds = new Set<string>();

    // Tier 0: Ingestion-Suspect Pairs
    if (this.ingestionRepo) {
      try {
        const suspects =
          await this.ingestionRepo.findIngestionDuplicateSuspects({
            userId: String(userId),
            projectId: effectiveProjectId,
          });
        const itemsMap = new Map<string, DuplicateCandidateItem>(
          items.map((it) => [it.id, it]),
        );

        for (const suspect of suspects) {
          const itemA = itemsMap.get(suspect.createdItemId);
          const itemB = itemsMap.get(suspect.targetItemId);
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
            const mappedItems = buildClusterItemList(pair);
            clusters.push({
              clusterId: `ingest-${suspect.runId.substring(0, 8)}-${itemA.id.substring(0, 8)}`,
              matchReason: 'INGESTION_SUSPECT',
              confidence: suspect.confidence,
              recommendedMasterId: this.computeRecommendedMasterId(pair),
              items: mappedItems,
              papers: mappedItems,
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
    const clusterByIdentifier = (
      idType: string,
      getIdFn: (it: DuplicateCandidateItem) => string | null | undefined,
      matchReason: 'EXACT_DOI' | 'EXACT_ARXIV' | 'EXACT_PMID' | 'EXACT_ISBN',
    ) => {
      const map = new Map<string, DuplicateCandidateItem[]>();
      for (const item of items) {
        if (groupedItemIds.has(item.id)) continue;
        const clean = String(getIdFn(item) || '')
          .toLowerCase()
          .trim();
        if (!clean) continue;
        const existing = map.get(clean) || [];
        existing.push(item);
        map.set(clean, existing);
      }

      map.forEach((matchedItems, idVal) => {
        if (matchedItems.length <= 1) return;
        const visitedInBucket = new Set<string>();

        for (let i = 0; i < matchedItems.length; i++) {
          const seed = matchedItems[i];
          if (visitedInBucket.has(seed.id) || groupedItemIds.has(seed.id)) {
            continue;
          }

          const compatibleGroup: DuplicateCandidateItem[] = [seed];
          for (let j = i + 1; j < matchedItems.length; j++) {
            const candidate = matchedItems[j];
            if (
              visitedInBucket.has(candidate.id) ||
              groupedItemIds.has(candidate.id)
            ) {
              continue;
            }
            if (
              compatibleGroup.every((existing) =>
                this.areCompatibleIdentifierDuplicates(
                  candidate,
                  existing,
                  idType,
                ),
              )
            ) {
              compatibleGroup.push(candidate);
              visitedInBucket.add(candidate.id);
            }
          }

          if (compatibleGroup.length > 1) {
            visitedInBucket.add(seed.id);
            compatibleGroup.forEach((m) => groupedItemIds.add(m.id));
            const mappedItems = buildClusterItemList(compatibleGroup);
            clusters.push({
              clusterId: `${idType}-${idVal.replace(/[^a-z0-9]/g, '-').substring(0, 32)}`,
              matchReason,
              confidence: 1.0,
              recommendedMasterId:
                this.computeRecommendedMasterId(compatibleGroup),
              items: mappedItems,
              papers: mappedItems,
            });
          }
        }
      });
    };

    clusterByIdentifier(
      'doi',
      (it) => normalizeDoi(it.doi) || it.doi,
      'EXACT_DOI',
    );
    clusterByIdentifier(
      'arxiv',
      (it) =>
        normalizeArxivId(
          (getEffectiveItemField(it, 'arxivId') as string | undefined) ||
            undefined,
          { stripVersion: true },
        ),
      'EXACT_ARXIV',
    );
    clusterByIdentifier(
      'pmid',
      (it) =>
        normalizePmid(
          (getEffectiveItemField(it, 'pmid') as string | undefined) ||
            undefined,
        ),
      'EXACT_PMID',
    );
    clusterByIdentifier(
      'isbn',
      (it) =>
        normalizeIsbn(
          (getEffectiveItemField(it, 'isbn') as string | undefined) ||
            undefined,
        ),
      'EXACT_ISBN',
    );

    // Tier 2: Fuzzy Title + Year (+/-1) + First Author
    const fuzzyBuckets = new Map<string, DuplicateCandidateItem[]>();
    for (const item of items) {
      if (groupedItemIds.has(item.id)) continue;
      if (normalizeTitleForDedupe(item.title).length < 5) continue;
      const bucketKey = generateDedupeBucketKey(
        item.title,
        getItemAuthors(item),
      );
      const bucket = fuzzyBuckets.get(bucketKey) || [];
      bucket.push(item);
      fuzzyBuckets.set(bucketKey, bucket);
    }

    fuzzyBuckets.forEach((bucket, key) => {
      if (bucket.length <= 1) return;
      const visited = new Set<string>();

      for (let i = 0; i < bucket.length; i++) {
        const itemA = bucket[i];
        if (visited.has(itemA.id) || groupedItemIds.has(itemA.id)) continue;

        const group = [itemA];
        for (let j = i + 1; j < bucket.length; j++) {
          const itemB = bucket[j];
          if (visited.has(itemB.id) || groupedItemIds.has(itemB.id)) continue;
          if (this.isDismissedPair(itemA, itemB)) continue;
          if (this.hasConflictingTier2BibliographicEvidence(itemA, itemB)) {
            continue;
          }

          const yearMatch =
            itemA.year == null ||
            itemB.year == null ||
            Math.abs(itemA.year - itemB.year) <= 1;
          if (
            yearMatch &&
            calculateTitleSimilarity(itemA.title, itemB.title) >= 0.88
          ) {
            group.push(itemB);
            visited.add(itemB.id);
          }
        }

        if (group.length > 1) {
          group.forEach((g) => groupedItemIds.add(g.id));
          const mappedItems = buildClusterItemList(group);
          clusters.push({
            clusterId: `fuzzy-${key.replace(/[^a-z0-9]/g, '-').substring(0, 24)}-${itemA.id.substring(0, 8)}`,
            matchReason: 'FUZZY_TITLE_YEAR_AUTHOR',
            confidence: 0.85,
            recommendedMasterId: this.computeRecommendedMasterId(group),
            items: mappedItems,
            papers: mappedItems,
          });
        }
      }
    });

    // Hydrate clustered items in a single batch query via findByIds + ItemsMapper.toDomain
    // so the frontend receives complete domain items and never needs N+1 GET /items/:id calls.
    if (
      clusters.length > 0 &&
      groupedItemIds.size > 0 &&
      typeof this.catalogGateway?.findByIds === 'function'
    ) {
      try {
        const fullRawItems = await this.catalogGateway.findByIds(
          String(userId),
          Array.from(groupedItemIds),
          effectiveProjectId,
        );
        if (Array.isArray(fullRawItems) && fullRawItems.length > 0) {
          const hydratedMap = new Map<string, DuplicateClusterItem>();
          for (const raw of fullRawItems) {
            if (!raw || !raw.id) continue;
            const domainItem = ItemsMapper.toDomain(
              raw,
            ) as unknown as DuplicateClusterItem;
            hydratedMap.set(raw.id, domainItem);
          }

          if (hydratedMap.size > 0) {
            for (const cluster of clusters) {
              const hydratedClusterItems = cluster.items.map((summaryItem) => {
                const full = hydratedMap.get(summaryItem.id);
                if (!full) return summaryItem;
                return {
                  ...summaryItem,
                  ...full,
                  id: summaryItem.id,
                  title: full.title || summaryItem.title,
                  itemType:
                    full.itemType || summaryItem.itemType || 'journalArticle',
                  doi: (full.doi ?? summaryItem.doi) || undefined,
                  year: full.year ?? summaryItem.year,
                  authors:
                    Array.isArray(full.authors) && full.authors.length > 0
                      ? full.authors
                      : summaryItem.authors,
                  citationKey:
                    (full.citationKey ?? summaryItem.citationKey) || undefined,
                };
              });
              cluster.items = hydratedClusterItems;
              cluster.papers = hydratedClusterItems;
            }
          }
        }
      } catch (err) {
        this.logger.warn(
          `Batch hydration of duplicate cluster items skipped: ${(err as Error).message}`,
        );
      }
    }

    return clusters;
  }

  private async rewireMergedItemRelations(
    tx: Prisma.TransactionClient,
    primaryId: string,
    uniqueDupIds: string[],
  ): Promise<void> {
    const existingRelations = await tx.itemRelation.findMany({
      where: {
        OR: [
          { sourceItemId: { in: [primaryId, ...uniqueDupIds] } },
          { targetItemId: { in: [primaryId, ...uniqueDupIds] } },
        ],
      },
    });

    const primaryExistingPairs = new Set<string>();
    for (const rel of existingRelations) {
      if (rel.sourceItemId === primaryId || rel.targetItemId === primaryId) {
        primaryExistingPairs.add(
          `${rel.sourceItemId}::${rel.targetItemId}::${rel.relationType}`,
        );
      }
    }

    for (const rel of existingRelations) {
      const isSourceDup = uniqueDupIds.includes(rel.sourceItemId);
      const isTargetDup = uniqueDupIds.includes(rel.targetItemId);
      if (!isSourceDup && !isTargetDup) continue;

      const newSourceId = isSourceDup ? primaryId : rel.sourceItemId;
      const newTargetId = isTargetDup ? primaryId : rel.targetItemId;

      if (newSourceId === newTargetId) {
        await tx.itemRelation.delete({ where: { id: rel.id } });
        continue;
      }

      const candidateKey = `${newSourceId}::${newTargetId}::${rel.relationType}`;
      if (primaryExistingPairs.has(candidateKey)) {
        await tx.itemRelation.delete({ where: { id: rel.id } });
      } else {
        await tx.itemRelation.update({
          where: { id: rel.id },
          data: { sourceItemId: newSourceId, targetItemId: newTargetId },
        });
        primaryExistingPairs.add(candidateKey);
      }
    }
  }

  private async consolidateUserPublications(
    tx: Prisma.TransactionClient,
    primaryId: string,
    uniqueDupIds: string[],
  ): Promise<void> {
    if (typeof tx.userPublication?.findMany !== 'function') return;
    const dupPublications = await tx.userPublication.findMany({
      where: { itemId: { in: uniqueDupIds } },
    });

    for (const pub of dupPublications) {
      const existingPrimaryPub = await tx.userPublication.findUnique({
        where: {
          userId_itemId: { userId: pub.userId, itemId: primaryId },
        },
      });

      if (!existingPrimaryPub) {
        await tx.userPublication.create({
          data: {
            userId: pub.userId,
            itemId: primaryId,
            contributorId: pub.contributorId,
            isPublic: pub.isPublic,
            openAccessLicense: pub.openAccessLicense,
            addedAt: pub.addedAt,
          },
        });
      } else {
        await tx.userPublication.update({
          where: {
            userId_itemId: { userId: pub.userId, itemId: primaryId },
          },
          data: {
            isPublic: existingPrimaryPub.isPublic || pub.isPublic,
            openAccessLicense:
              existingPrimaryPub.openAccessLicense || pub.openAccessLicense,
            contributorId:
              existingPrimaryPub.contributorId || pub.contributorId,
          },
        });
      }

      await tx.userPublication.delete({
        where: {
          userId_itemId: { userId: pub.userId, itemId: pub.itemId },
        },
      });
    }
  }

  private async syncMergedContributors(
    tx: Prisma.TransactionClient,
    primaryId: string,
    chosenContributors: ContributorShape[] | string[] | undefined,
    duplicates: Array<{ contributors?: unknown }>,
  ): Promise<void> {
    const mapContributorInput = (c: ContributorShape | string, idx: number) => {
      const cObj = typeof c === 'object' && c !== null ? c : null;
      const firstName = cObj?.firstName || '';
      const lastName = cObj?.lastName || '';
      const fullName =
        cObj?.fullName ||
        cObj?.name ||
        [firstName, lastName].filter(Boolean).join(' ') ||
        (typeof c === 'string' ? c : '');
      return {
        itemId: primaryId,
        creatorType: cObj?.creatorType || 'author',
        firstName,
        lastName,
        fullName,
        orderIndex: cObj?.orderIndex ?? idx,
      };
    };

    if (Array.isArray(chosenContributors) && chosenContributors.length > 0) {
      if (typeof tx.contributor?.deleteMany === 'function') {
        await tx.contributor.deleteMany({ where: { itemId: primaryId } });
        await tx.contributor.createMany({
          data: chosenContributors.map(mapContributorInput),
        });
      }
      return;
    }

    if (typeof tx.contributor?.count === 'function') {
      const primaryContribCount = await tx.contributor.count({
        where: { itemId: primaryId },
      });
      if (primaryContribCount === 0) {
        const donor = duplicates.find(
          (d) => Array.isArray(d.contributors) && d.contributors.length > 0,
        );
        if (donor && Array.isArray(donor.contributors)) {
          await tx.contributor.createMany({
            data: (donor.contributors as ContributorShape[]).map(
              mapContributorInput,
            ),
          });
        }
      }
    }
  }

  async mergeDuplicates(
    userId: UserId | string,
    dto: MergeDuplicatesDto,
    projectId?: ProjectId | string,
  ) {
    if (!dto.primaryItemId) {
      throw new BadRequestException('primaryItemId is required');
    }
    if (!dto.duplicateItemIds || dto.duplicateItemIds.length === 0) {
      throw new BadRequestException('duplicateItemIds must not be empty');
    }

    const uniqueDupIds = Array.from(new Set(dto.duplicateItemIds));
    if (uniqueDupIds.includes(dto.primaryItemId)) {
      throw new BadRequestException(
        'primaryItemId cannot be included in duplicateItemIds',
      );
    }

    if (dto.fieldSelections) {
      for (const field of Object.keys(dto.fieldSelections)) {
        if (SYSTEM_RESERVED_MERGE_KEYS.has(field)) {
          throw new BadRequestException(
            `Field "${field}" is a system-reserved key and is not allowed in merge fieldSelections`,
          );
        }
      }
    }

    const effectiveProjectId = this.normalizeScopeProjectId(
      projectId || dto.projectId,
    );
    const allItemIds = [dto.primaryItemId, ...uniqueDupIds];
    const items = this.catalogGateway
      ? await this.catalogGateway.findByIds(
          userId,
          allItemIds,
          effectiveProjectId,
        )
      : [];

    if (items.length !== allItemIds.length) {
      throw new NotFoundException(
        'One or more items do not exist, are already deleted, or belong to another user',
      );
    }

    for (const item of items) {
      if ('projectId' in item) {
        const itemProjectId = this.normalizeScopeProjectId(
          (item as { projectId?: string | null }).projectId,
        );
        if (itemProjectId !== effectiveProjectId) {
          throw new BadRequestException(
            'Cannot merge items across different library scopes (Personal vs Project or different Projects)',
          );
        }
      }
    }

    const primary = items.find((it) => it.id === dto.primaryItemId)!;
    const duplicates = items.filter((it) => it.id !== dto.primaryItemId);

    const selectedTargetType =
      typeof dto.fieldSelections?.itemType === 'string' &&
      dto.fieldSelections.itemType.trim().length > 0
        ? dto.fieldSelections.itemType.trim()
        : undefined;
    const effectiveMergedItemType =
      selectedTargetType ||
      primary.itemType ||
      primary.type ||
      'journalArticle';

    return this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const now = new Date();

        if (typeof tx.$executeRaw === 'function') {
          try {
            let hash = 0;
            for (let i = 0; i < primary.id.length; i++) {
              hash = (hash << 5) - hash + primary.id.charCodeAt(i);
              hash |= 0;
            }
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${Math.abs(hash)})`;
          } catch (err) {
            this.logger.warn(
              `Could not acquire pg_advisory_xact_lock: ${(err as Error).message}`,
            );
          }
        }

        if (this.extractionGateway?.reassignContentToItem) {
          await this.extractionGateway.reassignContentToItem(
            uniqueDupIds,
            primary.id,
            tx,
          );
        }

        if (this.catalogGateway) {
          await this.catalogGateway.mergeItems(tx, uniqueDupIds, primary.id);
        }

        await this.rewireMergedItemRelations(tx, primary.id, uniqueDupIds);
        await this.consolidateUserPublications(tx, primary.id, uniqueDupIds);

        if (typeof tx.itemMetadata?.updateMany === 'function') {
          await tx.itemMetadata.updateMany({
            where: { itemId: { in: uniqueDupIds } },
            data: { itemId: primary.id },
          });
        }

        // Provenance & Alias Citation Keys
        const primaryMeta = { ...asMetaObject(primary.metadata) };
        const extraIsObject =
          primaryMeta.extra !== null &&
          typeof primaryMeta.extra === 'object' &&
          !Array.isArray(primaryMeta.extra);
        const extraObj: Record<string, unknown> | undefined = extraIsObject
          ? { ...(primaryMeta.extra as Record<string, unknown>) }
          : undefined;

        const existingAliases: string[] = [
          ...(Array.isArray(primaryMeta.mergedCitationKeys)
            ? (primaryMeta.mergedCitationKeys as string[])
            : []),
          ...(extraObj && Array.isArray(extraObj.mergedCitationKeys)
            ? (extraObj.mergedCitationKeys as string[])
            : []),
        ];
        const dupCitationKeys = duplicates
          .flatMap((d) => {
            const dMeta = asMetaObject(d.metadata);
            const dAliases = Array.isArray(dMeta.mergedCitationKeys)
              ? (dMeta.mergedCitationKeys as string[])
              : [];
            return [d.citationKey, ...dAliases];
          })
          .filter((k): k is string =>
            Boolean(k?.trim() && k !== primary.citationKey),
          );
        const mergedAliases = Array.from(
          new Set([...existingAliases, ...dupCitationKeys]),
        );
        primaryMeta.mergedCitationKeys = mergedAliases;
        if (extraObj) extraObj.mergedCitationKeys = mergedAliases;

        const rawSelections = dto.fieldSelections || {};
        const {
          authors: selectedAuthors,
          creators: selectedCreators,
          contributors: selectedContributors,
          ...scalarSelections
        } = rawSelections;

        await this.syncMergedContributors(
          tx,
          primary.id,
          (selectedContributors || selectedAuthors || selectedCreators) as
            ContributorShape[] | string[] | undefined,
          duplicates,
        );

        // Automatic Field Backfilling
        const backfillFields: Record<string, unknown> = {};
        for (const field of ALLOWED_MERGE_METADATA_FIELDS) {
          if (field === 'extra' || scalarSelections[field] !== undefined) {
            continue;
          }
          if (
            getEffectiveItemField(primary, field, primaryMeta) === undefined
          ) {
            for (const dup of duplicates) {
              const dupVal = getEffectiveItemField(dup, field);
              if (dupVal !== undefined) {
                backfillFields[field] = dupVal;
                break;
              }
            }
          }
        }

        for (const idKey of IDENTIFIER_META_KEYS) {
          if (
            primaryMeta[idKey] === undefined ||
            primaryMeta[idKey] === null ||
            primaryMeta[idKey] === ''
          ) {
            const topOnPrimary = getEffectiveItemField(
              primary,
              idKey,
              primaryMeta,
            );
            if (topOnPrimary !== undefined) {
              primaryMeta[idKey] = topOnPrimary;
            } else {
              for (const dup of duplicates) {
                const candidateVal = getEffectiveItemField(dup, idKey);
                if (candidateVal !== undefined) {
                  primaryMeta[idKey] = candidateVal;
                  backfillFields[idKey] = candidateVal;
                  break;
                }
              }
            }
          }
        }

        // Non-destructively merge Zotero string `extra` lines
        if (scalarSelections.extra === undefined) {
          const extraLines: string[] = [];
          const seenLinesLower = new Set<string>();
          const pushExtraLines = (rawExtra: unknown) => {
            if (typeof rawExtra !== 'string' || !rawExtra.trim()) return;
            for (const line of rawExtra.split(/\r?\n/)) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const lower = trimmed.toLowerCase();
              if (!seenLinesLower.has(lower)) {
                seenLinesLower.add(lower);
                extraLines.push(trimmed);
              }
            }
          };

          pushExtraLines(primaryMeta.extra);
          pushExtraLines((primary as unknown as Record<string, unknown>).extra);
          for (const dup of duplicates) {
            pushExtraLines(asMetaObject(dup.metadata).extra);
            pushExtraLines((dup as unknown as Record<string, unknown>).extra);
          }

          if (extraLines.length > 0 && !extraObj) {
            primaryMeta.extra = extraLines.join('\n');
          } else if (extraObj) {
            primaryMeta.extra = extraObj;
          }
        }

        // Preserve My Publications & Retraction warnings across merge
        let mergedIsRetracted = Boolean(
          (primary as { isRetracted?: boolean }).isRetracted ||
          primaryMeta.isRetracted,
        );
        for (const dup of duplicates) {
          const dupMeta = asMetaObject(dup.metadata);
          if (dupMeta.isMyPublication === true) {
            primaryMeta.isMyPublication = true;
            for (const pubKey of [
              'publicationConfirmedAt',
              'openAccessLicense',
              'isPublicPublication',
            ] as const) {
              if (
                primaryMeta[pubKey] === undefined &&
                dupMeta[pubKey] !== undefined
              ) {
                primaryMeta[pubKey] = dupMeta[pubKey];
              }
            }
          }

          if (
            (dup as { isRetracted?: boolean }).isRetracted ||
            dupMeta.isRetracted ||
            dupMeta.retraction
          ) {
            mergedIsRetracted = true;
            primaryMeta.isRetracted = true;
            for (const rKey of RETRACTION_SURVIVAL_KEYS) {
              if (!primaryMeta[rKey] && dupMeta[rKey] !== undefined) {
                primaryMeta[rKey] = dupMeta[rKey];
              }
            }
          }
        }

        const currentHistory = Array.isArray(primaryMeta.mergeHistory)
          ? (primaryMeta.mergeHistory as unknown[])
          : [];
        primaryMeta.mergeHistory = [
          ...currentHistory,
          {
            mergedAt: now.toISOString(),
            duplicateItemIds: uniqueDupIds,
            backfilledFields: Object.keys(backfillFields),
          },
        ];

        const combinedUpdates = { ...backfillFields, ...scalarSelections };
        const topLevelData: Record<string, unknown> = {
          itemType: effectiveMergedItemType,
          ...(mergedIsRetracted ? { isRetracted: true } : {}),
        };
        for (const [key, val] of Object.entries(combinedUpdates)) {
          if (TOP_LEVEL_ITEM_COLUMNS.has(key)) {
            topLevelData[key] = val;
          } else {
            primaryMeta[key] = val;
          }
        }

        const updatedPrimary = await tx.item.update({
          where: { id: primary.id },
          data: {
            ...topLevelData,
            metadata: primaryMeta as Prisma.InputJsonValue,
            version: { increment: 1 },
          },
        });

        const eventScope = { userId, projectId: effectiveProjectId };
        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: updatedPrimary.id,
          action: 'update',
          version: updatedPrimary.version,
          data: updatedPrimary,
        });

        await helpers.publishOutbox(
          eventScope,
          primary.id,
          LIBRARY_EVENT_TYPES.ITEM_MERGED,
          {
            primaryItemId: primary.id,
            duplicateItemIds: uniqueDupIds,
            mergedCount: duplicates.length,
            mergedAt: now.toISOString(),
            projectId: effectiveProjectId,
          },
        );

        for (const dup of duplicates) {
          const dupMeta = {
            ...asMetaObject(dup.metadata),
            mergedIntoId: primary.id,
            mergedAt: now.toISOString(),
          };
          const softDeleted = await tx.item.update({
            where: { id: dup.id },
            data: {
              deletedAt: now,
              metadata: dupMeta,
              version: { increment: 1 },
            },
          });

          await helpers.recordTombstone(eventScope, {
            entityType: 'Item',
            entityId: dup.id,
          });
          await helpers.appendChange(eventScope, {
            entityType: 'Item',
            entityId: dup.id,
            action: 'delete',
            version: softDeleted.version,
            data: softDeleted,
          });
          await helpers.publishOutbox(
            eventScope,
            dup.id,
            'library.item.merged_into',
            {
              duplicateId: dup.id,
              primaryId: primary.id,
              userId,
              projectId: effectiveProjectId,
            },
          );
        }

        if (this.ingestionRepo) {
          try {
            await this.ingestionRepo.resolveReviewCasesForItems(allItemIds, tx);
          } catch (err) {
            this.logger.warn(
              `Could not resolve ingestion review cases: ${(err as Error).message}`,
            );
          }
        }

        const reloadedPrimary = await tx.item.findUnique({
          where: { id: primary.id },
          include: {
            contributors: { orderBy: { orderIndex: 'asc' } },
            collectionItems: { include: { collection: true } },
            itemTags: { include: { tag: true } },
            notesList: { where: { deletedAt: null } },
            attachments: { include: { revisions: true } },
          },
        });

        const finalPrimary = reloadedPrimary ?? updatedPrimary;
        const normPrimaryDoi = normalizeDoi(primary.doi);
        const matchReasons = Array.from(
          new Set(
            duplicates.map((dup) => {
              const normDupDoi = normalizeDoi(dup.doi);
              return normPrimaryDoi &&
                normDupDoi &&
                normPrimaryDoi === normDupDoi
                ? 'EXACT_DOI'
                : 'FUZZY_TITLE_YEAR_AUTHOR';
            }),
          ),
        );

        const preservedCitationKeys = Array.from(
          new Set(
            [
              (finalPrimary as { citationKey?: string | null }).citationKey ??
                primary.citationKey,
              ...(Array.isArray(primaryMeta.mergedCitationKeys)
                ? (primaryMeta.mergedCitationKeys as string[])
                : []),
            ].filter((k): k is string => typeof k === 'string' && k.length > 0),
          ),
        );

        const reloadedWithRelations = finalPrimary as {
          attachments?: unknown[];
          notesList?: unknown[];
          itemTags?: unknown[];
          collectionItems?: unknown[];
        };

        const audit: PrismaMergeAuditTrail = {
          masterItemId: primary.id,
          mergedDuplicateIds: uniqueDupIds,
          matchReasons,
          preservedCitationKeys,
          consolidatedAttachments: Array.isArray(
            reloadedWithRelations.attachments,
          )
            ? reloadedWithRelations.attachments.length
            : 0,
          consolidatedNotes: Array.isArray(reloadedWithRelations.notesList)
            ? reloadedWithRelations.notesList.length
            : 0,
          consolidatedTags: Array.isArray(reloadedWithRelations.itemTags)
            ? reloadedWithRelations.itemTags.length
            : 0,
          consolidatedCollections: Array.isArray(
            reloadedWithRelations.collectionItems,
          )
            ? reloadedWithRelations.collectionItems.length
            : 0,
          backfilledFields: Object.keys(backfillFields),
          timestamp: now.toISOString(),
        };

        return {
          primaryItem: finalPrimary,
          mergedCount: duplicates.length,
          softDeletedItemIds: uniqueDupIds,
          audit,
          prismaAudit: audit,
        };
      },
    );
  }
}
