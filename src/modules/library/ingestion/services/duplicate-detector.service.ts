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
  CATALOG_FACADE,
  ICatalogFacade,
  DuplicateCandidateItem,
} from '@/modules/library/core';
import { ItemsMapper } from '@/modules/library/catalog';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import {
  DuplicateClusterResult,
  DuplicateClusterItem,
} from '@/modules/library/ingestion/types/curation.types';
import { UserId, ProjectId } from '@/modules/library/core/types/branded.types';
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
} from '@/modules/library/core';

export function asMetaObject(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

export function getEffectiveItemField(
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
export class DuplicateDetectorService {
  private readonly logger = new Logger(DuplicateDetectorService.name);

  constructor(
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    private readonly ingestionRepo?: IngestionRepository,
    @Optional()
    private readonly libraryTx?: TransactionService,
  ) {}

  normalizeScopeProjectId(
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

  areCompatibleIdentifierDuplicates(
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

    const toStr = (v: unknown) =>
      typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';

    const involvesBookChapter =
      typeA === 'bookSection' ||
      typeB === 'bookSection' ||
      typeA === 'chapter' ||
      typeB === 'chapter';
    if (involvesBookChapter) {
      const titleSim = calculateTitleSimilarity(itemA.title, itemB.title);
      if (titleSim < 0.78) return false;
      const pagesA = toStr(metaA.pages).toLowerCase();
      const pagesB = toStr(metaB.pages).toLowerCase();
      if (pagesA && pagesB && pagesA !== pagesB && titleSim < 0.92) {
        return false;
      }
    }

    if (idType === 'isbn') {
      for (const locatorKey of ['volume', 'edition'] as const) {
        const valA = toStr(metaA[locatorKey]).toLowerCase();
        const valB = toStr(metaB[locatorKey]).toLowerCase();
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

  hasConflictingTier2BibliographicEvidence(
    itemA: DuplicateCandidateItem,
    itemB: DuplicateCandidateItem,
  ): boolean {
    if (
      isGenericBoilerplateTitle(itemA.title) ||
      isGenericBoilerplateTitle(itemB.title)
    ) {
      return true;
    }

    const toStr = (v: unknown) =>
      typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';

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

    const pagesA = toStr(metaA.pages);
    const pagesB = toStr(metaB.pages);
    if (pagesA && pagesB) {
      const startPageA = pagesA.match(/\d+/)?.[0];
      const startPageB = pagesB.match(/\d+/)?.[0];
      if (startPageA && startPageB && startPageA !== startPageB) return true;
    }

    const issueA = toStr(metaA.issue).toLowerCase();
    const issueB = toStr(metaB.issue).toLowerCase();
    return Boolean(issueA && issueB && issueA !== issueB);
  }

  computeRecommendedMasterId(group: DuplicateCandidateItem[]): string {
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

    if (this.libraryTx) {
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
    }

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

    const mapToClusterItem = (
      m: DuplicateCandidateItem,
      hydratedRaw?: Record<string, unknown>,
    ): DuplicateClusterItem => {
      const source = hydratedRaw ? { ...m, ...hydratedRaw } : m;
      const domainProjected = (hydratedRaw &&
      Array.isArray(hydratedRaw.creators) &&
      Array.isArray(hydratedRaw.tags) &&
      typeof hydratedRaw.createdAt === 'string'
        ? hydratedRaw
        : ItemsMapper.toDomain({
            ...source,
            itemType: this.resolveItemType(source),
            authors: getItemAuthors(
              source as unknown as DuplicateCandidateItem & {
                authors?: string[];
              },
            ),
          })) as unknown as DuplicateClusterItem;

      return {
        ...domainProjected,
        id: m.id,
        title: domainProjected.title || m.title,
        itemType:
          domainProjected.itemType ||
          this.resolveItemType(m) ||
          'journalArticle',
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
    };

    const candidateById = new Map<string, DuplicateCandidateItem>(
      items.map((it) => [it.id, it]),
    );
    const rawClusters: Array<{
      clusterId: string;
      matchReason: DuplicateClusterResult['matchReason'];
      confidence: number;
      recommendedMasterId: string;
      rawGroup: DuplicateCandidateItem[];
    }> = [];
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
            rawClusters.push({
              clusterId: `${idType}-${idVal.replace(/[^a-z0-9]/g, '-').substring(0, 32)}`,
              matchReason,
              confidence: 1.0,
              recommendedMasterId:
                this.computeRecommendedMasterId(compatibleGroup),
              rawGroup: compatibleGroup,
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
          rawClusters.push({
            clusterId: `fuzzy-${key.replace(/[^a-z0-9]/g, '-').substring(0, 24)}-${itemA.id.substring(0, 8)}`,
            matchReason: 'FUZZY_TITLE_YEAR_AUTHOR',
            confidence: 0.85,
            recommendedMasterId: this.computeRecommendedMasterId(group),
            rawGroup: group,
          });
        }
      }
    });

    const hydratedRawById = new Map<string, Record<string, unknown>>();
    if (
      rawClusters.length > 0 &&
      groupedItemIds.size > 0 &&
      typeof this.catalogGateway?.findByIds === 'function'
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
        mapToClusterItem(m, hydratedRawById.get(m.id)),
      );
      return {
        clusterId: rc.clusterId,
        matchReason: rc.matchReason,
        confidence: rc.confidence,
        recommendedMasterId: rc.recommendedMasterId,
        items: mappedItems,
        papers: mappedItems,
      };
    });
  }
}
