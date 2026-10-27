import {
  DuplicateCandidateItem,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
} from '@/modules/library/core';
import { ItemsMapper } from '@/modules/library/catalog/catalog.facade';
import {
  DuplicateClusterResult,
  DuplicateClusterItem,
} from '@/modules/library/ingestion/types/curation.types';
import {
  normalizeTitleForDedupe,
  extractContributorAuthors,
  generateDedupeBucketKey,
  calculateTitleSimilarity,
} from './deduplication.domain';

export interface RawDuplicateCluster {
  clusterId: string;
  matchReason: DuplicateClusterResult['matchReason'];
  confidence: number;
  recommendedMasterId: string;
  rawGroup: DuplicateCandidateItem[];
}

export function getCandidateItemAuthors(
  item: DuplicateCandidateItem & { authors?: string[] },
): string[] {
  const fromContributors = extractContributorAuthors(item);
  return fromContributors.length > 0 ? fromContributors : item.authors || [];
}

export function mapCandidateToClusterItem(
  m: DuplicateCandidateItem,
  resolveItemType: (item: unknown) => string,
  hydratedRaw?: Record<string, unknown>,
): DuplicateClusterItem {
  const source = hydratedRaw ? { ...m, ...hydratedRaw } : m;
  const domainProjected = (hydratedRaw &&
  Array.isArray(hydratedRaw.creators) &&
  Array.isArray(hydratedRaw.tags) &&
  typeof hydratedRaw.createdAt === 'string'
    ? hydratedRaw
    : ItemsMapper.toDomain({
        ...source,
        itemType: resolveItemType(source),
        authors: getCandidateItemAuthors(
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
      domainProjected.itemType || resolveItemType(m) || 'journalArticle',
    doi: (domainProjected.doi || m.doi) ?? undefined,
    year: domainProjected.year ?? m.year ?? undefined,
    authors:
      Array.isArray(domainProjected.authors) &&
      domainProjected.authors.length > 0
        ? domainProjected.authors
        : getCandidateItemAuthors(m),
    citationKey: (domainProjected.citationKey || m.citationKey) ?? undefined,
  };
}

export function collectExactIdentifierClusters(params: {
  items: DuplicateCandidateItem[];
  groupedItemIds: Set<string>;
  rawClusters: RawDuplicateCluster[];
  getEffectiveItemField: (item: unknown, field: string) => unknown;
  areCompatibleIdentifierDuplicates: (
    itemA: DuplicateCandidateItem,
    itemB: DuplicateCandidateItem,
    matchedIdentifierType: string,
  ) => boolean;
  computeRecommendedMasterId: (items: DuplicateCandidateItem[]) => string;
}): void {
  const {
    items,
    groupedItemIds,
    rawClusters,
    getEffectiveItemField,
    areCompatibleIdentifierDuplicates,
    computeRecommendedMasterId,
  } = params;

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
              areCompatibleIdentifierDuplicates(candidate, existing, idType),
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
            recommendedMasterId: computeRecommendedMasterId(compatibleGroup),
            rawGroup: compatibleGroup,
          });
        }
      }
    });
  };

  const idSpecs: Array<
    [
      'doi' | 'arxivId' | 'pmid' | 'isbn',
      (val?: string | null) => string | undefined,
      'EXACT_DOI' | 'EXACT_ARXIV' | 'EXACT_PMID' | 'EXACT_ISBN',
    ]
  > = [
    ['doi', normalizeDoi, 'EXACT_DOI'],
    [
      'arxivId',
      (val) => normalizeArxivId(val, { stripVersion: true }),
      'EXACT_ARXIV',
    ],
    ['pmid', normalizePmid, 'EXACT_PMID'],
    ['isbn', normalizeIsbn, 'EXACT_ISBN'],
  ];
  for (const [field, normFn, reason] of idSpecs) {
    clusterByIdentifier(
      field,
      (it) =>
        normFn(
          (getEffectiveItemField(it, field) as string | undefined) || undefined,
        ),
      reason,
    );
  }
}

export function collectFuzzyTitleYearAuthorClusters(params: {
  items: DuplicateCandidateItem[];
  groupedItemIds: Set<string>;
  rawClusters: RawDuplicateCluster[];
  isDismissedPair: (
    itemA: DuplicateCandidateItem,
    itemB: DuplicateCandidateItem,
  ) => boolean;
  hasConflictingTier2BibliographicEvidence: (
    itemA: DuplicateCandidateItem,
    itemB: DuplicateCandidateItem,
  ) => boolean;
  computeRecommendedMasterId: (items: DuplicateCandidateItem[]) => string;
}): void {
  const {
    items,
    groupedItemIds,
    rawClusters,
    isDismissedPair,
    hasConflictingTier2BibliographicEvidence,
    computeRecommendedMasterId,
  } = params;

  const fuzzyBuckets = new Map<string, DuplicateCandidateItem[]>();
  for (const item of items) {
    if (groupedItemIds.has(item.id)) continue;
    if (normalizeTitleForDedupe(item.title).length < 5) continue;
    const bucketKey = generateDedupeBucketKey(
      item.title,
      getCandidateItemAuthors(item),
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
        if (isDismissedPair(itemA, itemB)) continue;
        if (hasConflictingTier2BibliographicEvidence(itemA, itemB)) {
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
          recommendedMasterId: computeRecommendedMasterId(group),
          rawGroup: group,
        });
      }
    }
  });
}
