import {
  DuplicateCandidateItem,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
} from '@/modules/library/core';
import { ItemsMapper } from '@/modules/library/catalog';
import {
  DuplicateClusterResult,
  DuplicateClusterItem,
} from '@/modules/library/ingestion/types/curation.types';
import {
  normalizeTitleForDedupe,
  extractContributorAuthors,
  generateDedupeBucketKey,
  calculateTitleSimilarity,
  hasConflictingPartOrSupplementMarkers,
} from './deduplication.domain';
import { PREPRINT_SERVER_VENUE_REGEX } from './field-reconciliation.strategies';

export { PREPRINT_SERVER_VENUE_REGEX };

export interface RawDuplicateCluster {
  clusterId: string;
  matchReason: DuplicateClusterResult['matchReason'];
  confidence: number;
  recommendedMasterId: string;
  rawGroup: DuplicateCandidateItem[];
}

export function isPreprintDoiValue(doi?: string | null): boolean {
  if (!doi) return false;
  const norm = (normalizeDoi(doi) || doi).toLowerCase().trim();
  return (
    norm.startsWith('10.48550/arxiv.') ||
    norm.startsWith('10.1101/') ||
    norm.startsWith('10.21203/') ||
    norm.startsWith('10.26434/') ||
    norm.startsWith('10.2139/ssrn.') ||
    norm.startsWith('10.5281/zenodo.') ||
    norm.startsWith('10.31219/osf.io/') ||
    norm.startsWith('10.36227/techrxiv.') ||
    norm.startsWith('10.13140/rg.') ||
    norm.includes('/arxiv.')
  );
}

export function isPreprintCandidateItem(item: DuplicateCandidateItem): boolean {
  const rec = item as unknown as Record<string, unknown>;
  const meta =
    item.metadata &&
    typeof item.metadata === 'object' &&
    !Array.isArray(item.metadata)
      ? item.metadata
      : {};
  const itemType = String(item.itemType || meta.itemType || '').trim();
  if (itemType === 'preprint') return true;
  if (isPreprintDoiValue(item.doi || (meta.doi as string | undefined))) {
    return true;
  }
  const rawArxiv =
    rec.arxivId ?? meta.arxivId ?? meta.archiveID ?? meta.archiveId;
  if (typeof rawArxiv === 'string' && rawArxiv.trim().length > 0) {
    return true;
  }
  for (const k of ['publicationTitle', 'journal', 'repository', 'venue']) {
    const val = String(rec[k] ?? meta[k] ?? '').trim();
    if (
      val &&
      (PREPRINT_SERVER_VENUE_REGEX.test(val) || /^arxiv\s*:/i.test(val))
    ) {
      return true;
    }
  }
  return false;
}

const WORD_ORDINAL_TO_NUMBER: Readonly<Record<string, string>> = {
  first: '1',
  second: '2',
  third: '3',
  fourth: '4',
  fifth: '5',
  sixth: '6',
  seventh: '7',
  eighth: '8',
  ninth: '9',
  tenth: '10',
  i: '1',
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
};

export function normalizeNumericLocatorToken(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  const digitMatch = trimmed.match(/\b(\d+)(?:st|nd|rd|th)?\b/);
  if (digitMatch && digitMatch[1]) {
    return String(parseInt(digitMatch[1], 10));
  }
  const cleanedWords = trimmed
    .replace(/\b(?:vol(?:ume)?|ed(?:ition)?|rev(?:ised)?)\.?\b/g, ' ')
    .trim();
  for (const token of cleanedWords.split(/[^a-z0-9]+/)) {
    if (token && WORD_ORDINAL_TO_NUMBER[token]) {
      return WORD_ORDINAL_TO_NUMBER[token];
    }
  }
  return trimmed.replace(/[^a-z0-9]/g, '');
}

export function normalizeIssueToken(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/^(?:no\.?|issue|iss\.?|number|num\.?|#)\s*/i, '')
    .trim()
    .toLowerCase();
  if (!trimmed) return '';
  return trimmed.replace(/\b0+(\d+)\b/g, '$1');
}

export function isLocalOrElectronicPageRange(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^(?:e\d+|art(?:icle)?[\s.:#-]*\d+|\d{5,})\b/i.test(trimmed)) {
    return true;
  }
  if (/^1(?:\s*[-–—]\s*\d+|\s*pp?\.?)?$/i.test(trimmed)) {
    return true;
  }
  return false;
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
  isDismissedPair?: (
    itemA: DuplicateCandidateItem,
    itemB: DuplicateCandidateItem,
  ) => boolean;
}): void {
  const {
    items,
    groupedItemIds,
    rawClusters,
    getEffectiveItemField,
    areCompatibleIdentifierDuplicates,
    computeRecommendedMasterId,
    isDismissedPair,
  } = params;

  const clusterByIdentifier = (
    idType: string,
    getIdFn: (it: DuplicateCandidateItem) => string | null | undefined,
    matchReason: 'EXACT_DOI' | 'EXACT_ARXIV' | 'EXACT_PMID' | 'EXACT_ISBN',
  ) => {
    // Absorb ungrouped items matching an existing Tier 0 INGESTION_SUSPECT cluster's exact identifier
    for (const rc of rawClusters) {
      if (rc.matchReason !== 'INGESTION_SUSPECT') continue;
      const clusterIds = new Set<string>();
      for (const member of rc.rawGroup) {
        const cleanMemberId = String(getIdFn(member) || '')
          .toLowerCase()
          .trim();
        if (cleanMemberId) clusterIds.add(cleanMemberId);
      }
      if (clusterIds.size === 0) continue;

      let absorbed = false;
      for (const item of items) {
        if (groupedItemIds.has(item.id)) continue;
        const cleanItemId = String(getIdFn(item) || '')
          .toLowerCase()
          .trim();
        if (!cleanItemId || !clusterIds.has(cleanItemId)) continue;
        if (
          rc.rawGroup.every(
            (existing) =>
              (!isDismissedPair || !isDismissedPair(item, existing)) &&
              areCompatibleIdentifierDuplicates(item, existing, idType),
          )
        ) {
          rc.rawGroup.push(item);
          groupedItemIds.add(item.id);
          absorbed = true;
        }
      }
      if (absorbed) {
        rc.recommendedMasterId = computeRecommendedMasterId(rc.rawGroup);
      }
    }

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
            compatibleGroup.every(
              (existing) =>
                (!isDismissedPair || !isDismissedPair(candidate, existing)) &&
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

        const isCompatibleWithAll = group.every((member) => {
          if (isDismissedPair(member, itemB)) return false;
          if (hasConflictingTier2BibliographicEvidence(member, itemB)) {
            return false;
          }
          if (
            hasConflictingPartOrSupplementMarkers(
              member.title || '',
              itemB.title || '',
            )
          ) {
            return false;
          }
          const isPreprintEvolution =
            isPreprintCandidateItem(member) || isPreprintCandidateItem(itemB);
          const maxYearGap = isPreprintEvolution ? 3 : 1;
          const yearMatch =
            member.year == null ||
            itemB.year == null ||
            Math.abs(member.year - itemB.year) <= maxYearGap;
          if (!yearMatch) return false;
          return calculateTitleSimilarity(member.title, itemB.title) >= 0.88;
        });

        if (isCompatibleWithAll) {
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
