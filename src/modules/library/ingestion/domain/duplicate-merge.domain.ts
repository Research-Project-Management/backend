import { Prisma, IngestionStatus } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { asMetaObject, getEffectiveItemField } from './duplicate-clustering.helper';
import {
  normalizeDoi, normalizeArxivId, normalizePmid, normalizePmcid, normalizeIsbn, normalizeIssn,
  PRISMA_ITEM_SCALAR_COLUMNS, ItemProvenancePolicy, FieldProvenanceRecord, isPlaceholderItemTitle,
  deriveFirstAuthor, PREPRINT_SERVER_VENUE_REGEX, parseCreatorString, countFullGivenNames,
  isBetterAuthorListCandidate,
} from '@/modules/library/core';
import { ALLOWED_MERGE_METADATA_FIELDS, PrismaMergeAuditTrail } from '@/modules/library/ingestion/types/ingestion.types';

export interface ContributorShape {
  creatorType?: string; fieldMode?: number; firstName?: string; lastName?: string;
  fullName?: string; shortName?: string | null; name?: string; orderIndex?: number;
}

export const IDENTIFIER_META_KEYS = ['arxivId', 'pmid', 'pmcid', 'isbn', 'issn'] as const;
export type IngestionScope = { userId?: string; projectId?: string | null } | string;

export interface CreateIngestionRunData {
  id?: string; userId?: string; projectId?: string | null; traceId?: string | null;
  inputParams: Prisma.InputJsonValue; inputHash: string; idempotencyKey?: string | null;
  contractVersion?: string; pipelineVersion?: string; status?: IngestionStatus; nextRetryAt?: Date | null;
}

export interface CreateIngestionStageData {
  stageName: string; durationMs?: number; success?: boolean; errorMessage?: string;
  outputSnapshot?: Prisma.InputJsonValue; leaseToken?: string; leaseExpiresAt?: Date;
}

export interface CreateIngestionReviewCaseData {
  targetItemId?: string; reason: string; evidence?: Prisma.InputJsonValue; options?: Prisma.InputJsonValue;
  status?: string; resolution?: string; assignedToUserId?: string; assignedToId?: string;
}

export function parseRunScope(
  scope?: IngestionScope,
  fallbackUserId?: string,
): { userId: string; projectId: string | null } {
  if (typeof scope === 'object' && scope !== null) {
    const rawProject = scope.projectId;
    const resolvedUserId = scope.userId || fallbackUserId;
    if (!resolvedUserId) throw new BadRequestException('User context (userId) is required for ingestion run operations');
    return { userId: resolvedUserId, projectId: rawProject && isUUID(rawProject) ? rawProject : null };
  }
  const str = typeof scope === 'string' ? scope : '';
  const isProject = str && str !== 'user' && str !== 'me' && str !== fallbackUserId && isUUID(str);
  const resolvedUserId = fallbackUserId || (!isProject && str ? str : '');
  if (!resolvedUserId) throw new BadRequestException('User context (userId) is required for ingestion run operations');
  return { userId: resolvedUserId, projectId: isProject ? str : null };
}

export function buildMergeAuditTrail(params: {
  primary: { id: string; doi?: string | null; citationKey?: string | null };
  duplicates: Array<{ doi?: string | null }>; uniqueDupIds: string[]; finalPrimary: unknown;
  primaryMeta: Record<string, unknown>; backfillFields: Record<string, unknown>; now: Date;
}): PrismaMergeAuditTrail {
  const { primary, duplicates, uniqueDupIds, finalPrimary, primaryMeta, backfillFields, now } = params;
  const normPrimaryDoi = normalizeDoi(primary.doi);
  const matchReasons = Array.from(new Set(duplicates.map((dup) => {
    const normDupDoi = normalizeDoi(dup.doi);
    return normPrimaryDoi && normDupDoi && normPrimaryDoi === normDupDoi ? 'EXACT_DOI' : 'FUZZY_TITLE_YEAR_AUTHOR';
  })));
  const preservedCitationKeys = Array.from(new Set([
    (finalPrimary as { citationKey?: string | null }).citationKey ?? primary.citationKey,
    ...(Array.isArray(primaryMeta.mergedCitationKeys) ? (primaryMeta.mergedCitationKeys as string[]) : []),
  ].filter((k): k is string => typeof k === 'string' && k.length > 0)));
  const rels = finalPrimary as { attachments?: unknown[]; notesList?: unknown[]; itemTags?: unknown[]; collectionItems?: unknown[] };
  return {
    masterItemId: primary.id, mergedDuplicateIds: uniqueDupIds, matchReasons, preservedCitationKeys,
    consolidatedAttachments: Array.isArray(rels.attachments) ? rels.attachments.length : 0,
    consolidatedNotes: Array.isArray(rels.notesList) ? rels.notesList.length : 0,
    consolidatedTags: Array.isArray(rels.itemTags) ? rels.itemTags.length : 0,
    consolidatedCollections: Array.isArray(rels.collectionItems) ? rels.collectionItems.length : 0,
    backfilledFields: Object.keys(backfillFields), timestamp: now.toISOString(),
  };
}

const INVERSE_RELATION_TYPE_MAP: Readonly<Record<string, string>> = {
  cites: 'cited_by', cited_by: 'cites',
  is_preprint_of: 'is_published_version_of', is_published_version_of: 'is_preprint_of',
  is_supplement_to: 'has_supplement', has_supplement: 'is_supplement_to',
  is_part_of: 'has_part', has_part: 'is_part_of',
  related_to: 'related_to', related: 'related',
};

export function registerRelationPairWithReciprocal(
  pairSet: Set<string>, sourceId: string, targetId: string, relationType: string,
): void {
  pairSet.add(`${sourceId}::${targetId}::${relationType}`);
  const inverseType = INVERSE_RELATION_TYPE_MAP[relationType];
  if (inverseType) pairSet.add(`${targetId}::${sourceId}::${inverseType}`);
}

export function planMergedItemRelations(
  existingRelations: Array<{ id: string; sourceItemId: string; targetItemId: string; relationType: string }>,
  primaryId: string,
  uniqueDupIds: string[],
): {
  relationIdsToDelete: string[];
  relationUpdates: Array<{ id: string; sourceItemId: string; targetItemId: string }>;
} {
  const primaryExistingPairs = new Set<string>();
  for (const rel of existingRelations) {
    if (
      (rel.sourceItemId === primaryId || rel.targetItemId === primaryId) &&
      !uniqueDupIds.includes(rel.sourceItemId) &&
      !uniqueDupIds.includes(rel.targetItemId)
    ) {
      registerRelationPairWithReciprocal(primaryExistingPairs, rel.sourceItemId, rel.targetItemId, rel.relationType);
    }
  }
  const relationIdsToDelete: string[] = [];
  const relationUpdates: Array<{ id: string; sourceItemId: string; targetItemId: string }> = [];
  for (const rel of existingRelations) {
    const isSourceDup = uniqueDupIds.includes(rel.sourceItemId);
    const isTargetDup = uniqueDupIds.includes(rel.targetItemId);
    if (!isSourceDup && !isTargetDup) continue;
    const newSourceId = isSourceDup ? primaryId : rel.sourceItemId;
    const newTargetId = isTargetDup ? primaryId : rel.targetItemId;
    if (newSourceId === newTargetId || primaryExistingPairs.has(`${newSourceId}::${newTargetId}::${rel.relationType}`)) {
      relationIdsToDelete.push(rel.id);
    } else {
      relationUpdates.push({ id: rel.id, sourceItemId: newSourceId, targetItemId: newTargetId });
      registerRelationPairWithReciprocal(primaryExistingPairs, newSourceId, newTargetId, rel.relationType);
    }
  }
  return { relationIdsToDelete, relationUpdates };
}

export const VENUE_ALIAS_MERGE_KEYS = [
  'proceedingsTitle', 'bookTitle', 'encyclopediaTitle', 'dictionaryTitle',
  'blogTitle', 'forumTitle', 'websiteTitle', 'programTitle', 'repository',
] as const;

export const SYSTEM_RESERVED_MERGE_KEYS = new Set([
  'id', 'userId', 'projectId', 'deletedAt', 'createdAt', 'updatedAt', 'version',
  'attachmentCount', 'noteCount', 'hasFile', 'normalizedTitle', 'searchVector',
  'firstAuthor', 'isRetracted', 'retraction', 'retractionDate', 'retractionNature',
  'retractionDetails', 'retractionCheckedAt', 'retractionReasons', 'retractionNoticeDoi',
  'retractionSource', 'mergeHistory', 'fieldProvenance', 'lockedFields',
  'dismissedDuplicateIds', 'mergedCitationKeys', 'metadata', 'mergedIntoId',
  'mergedAt', 'mergedFromIds', '__proto__', 'constructor', 'prototype',
]);

export const TOP_LEVEL_ITEM_COLUMNS = new Set<string>(PRISMA_ITEM_SCALAR_COLUMNS);
export const RETRACTION_SURVIVAL_KEYS = [
  'isRetracted', 'retraction', 'retractionDate', 'retractionNature',
  'retractionDetails', 'retractionCheckedAt', 'retractionReasons',
  'retractionNoticeDoi', 'retractionSource',
] as const;

export interface MappedContributorRecord extends Record<string, unknown> {
  itemId: string; creatorType: string; fieldMode: number;
  firstName: string; lastName: string; fullName: string; shortName: string; orderIndex: number;
}

export function mapContributorInputForPrimary(
  primaryId: string, c: ContributorShape | string, idx: number,
): MappedContributorRecord {
  const cObj = typeof c === 'object' && c !== null ? c : null;
  const creatorType = cObj?.creatorType || 'author';
  let firstName = (cObj?.firstName || '').trim();
  let lastName = (cObj?.lastName || '').trim();
  let fullName = (
    cObj?.fullName || cObj?.name || [firstName, lastName].filter(Boolean).join(' ') || (typeof c === 'string' ? c : '')
  ).trim();
  if (!firstName && !lastName && fullName) {
    const parsed = parseCreatorString(fullName, idx, creatorType);
    firstName = parsed.firstName || '';
    lastName = parsed.lastName || '';
    fullName = parsed.fullName || fullName;
  }
  return {
    itemId: primaryId, creatorType, fieldMode: cObj?.fieldMode ?? 0,
    firstName, lastName, fullName, shortName: cObj?.shortName ?? '', orderIndex: cObj?.orderIndex ?? idx,
  };
}

export function syncContributorsToMeta(
  primaryMeta: Record<string, unknown> | undefined,
  mapped: MappedContributorRecord[],
): void {
  if (!primaryMeta) return;
  primaryMeta.creators = mapped.map((c) => ({
    creatorType: c.creatorType, fieldMode: c.fieldMode, firstName: c.firstName,
    lastName: c.lastName, fullName: c.fullName, name: c.fullName, orderIndex: c.orderIndex,
  }));
  primaryMeta.authors = mapped
    .filter((c) => !c.creatorType || c.creatorType === 'author')
    .map((c) => c.fullName || [c.firstName, c.lastName].filter(Boolean).join(' '))
    .filter(Boolean);
}

export function extractItemContributors(item?: {
  contributors?: unknown;
  metadata?: unknown;
}): Array<ContributorShape | string> {
  if (!item) return [];
  if (Array.isArray(item.contributors) && item.contributors.length > 0) return item.contributors as ContributorShape[];
  const meta = asMetaObject(item.metadata);
  if (Array.isArray(meta.creators) && meta.creators.length > 0) return meta.creators as ContributorShape[];
  if (Array.isArray(meta.authors) && meta.authors.length > 0) return meta.authors as Array<ContributorShape | string>;
  return [];
}

export function selectBestDonorContributors(
  duplicates: Array<{ contributors?: unknown; metadata?: unknown }>,
): { list: Array<ContributorShape | string>; auth: number; fullGivenCount: number } | null {
  const sortedDups = duplicates
    .map((dup) => {
      const list = extractItemContributors(dup);
      return {
        list,
        auth: ItemProvenancePolicy.getFieldAuthority(dup, 'creators', list.length > 0, ['authors', 'contributors']),
        fullGivenCount: countFullGivenNames(list),
      };
    })
    .filter((e) => e.list.length > 0)
    .sort((a, b) => b.auth - a.auth || b.fullGivenCount - a.fullGivenCount || b.list.length - a.list.length);
  return sortedDups[0] ?? null;
}

export function shouldUpgradePrimaryContributors(
  primary: Record<string, unknown> | undefined,
  effectivePrimaryMeta: Record<string, unknown>,
  primaryContribs: Array<ContributorShape | string>,
  bestDonor: { list: Array<ContributorShape | string>; auth: number; fullGivenCount: number },
): boolean {
  const primaryAuth = ItemProvenancePolicy.getFieldAuthority(
    primary ?? effectivePrimaryMeta, 'creators', true, ['authors', 'contributors'],
  );
  return isBetterAuthorListCandidate(
    bestDonor.auth, bestDonor.list.length, bestDonor.fullGivenCount,
    primaryAuth, primaryContribs.length, countFullGivenNames(primaryContribs),
  );
}

const canonicalIdType = (t: string) => {
  const norm = t.trim().toLowerCase();
  return norm === 'arxivid' || norm === 'archiveid' ? 'arxiv' : norm;
};

export function computeClearedCanonicalIdentifierTypes(
  topLevelData: Record<string, unknown>,
  primaryMeta: Record<string, unknown>,
  explicitlyClearedFields?: ReadonlySet<string>,
): Set<string> {
  const clearedCanonicalTypes = new Set<string>();
  if (explicitlyClearedFields) {
    for (const f of explicitlyClearedFields) {
      const cType = canonicalIdType(f);
      if (['doi', 'arxiv', 'pmid', 'pmcid', 'isbn', 'issn'].includes(cType)) clearedCanonicalTypes.add(cType);
    }
  }
  if (topLevelData.doi === null) clearedCanonicalTypes.add('doi');
  if (clearedCanonicalTypes.has('doi')) {
    topLevelData.doi = null;
    delete primaryMeta.doi;
    delete primaryMeta.DOI;
  }
  for (const key of IDENTIFIER_META_KEYS) {
    const cType = key === 'arxivId' ? 'arxiv' : key;
    if (clearedCanonicalTypes.has(cType)) {
      delete primaryMeta[key];
      for (const alias of ItemProvenancePolicy.getCoupledFieldAliases(key)) delete primaryMeta[alias];
    }
  }
  return clearedCanonicalTypes;
}

export function computeDesiredMergedIdentifierRecords(params: {
  primaryId: string;
  existingIdRecords: Array<{ itemId: string; type: string; value: string; canonicalUri?: string | null }>;
  clearedCanonicalTypes: ReadonlySet<string>;
  topLevelData: Record<string, unknown>;
  primaryMeta: Record<string, unknown>;
  primaryDoi?: string | null;
}): Map<string, { type: string; value: string; canonicalUri: string }> {
  const { primaryId, existingIdRecords, clearedCanonicalTypes, topLevelData, primaryMeta, primaryDoi } = params;
  const desiredByType = new Map<string, { type: string; value: string; canonicalUri: string }>();
  for (const rec of existingIdRecords) {
    if (rec.itemId === primaryId && rec.type && rec.value) {
      const cType = canonicalIdType(rec.type);
      if (!clearedCanonicalTypes.has(cType)) {
        desiredByType.set(cType, { type: cType, value: rec.value, canonicalUri: rec.canonicalUri || rec.value });
      }
    }
  }
  for (const rec of existingIdRecords) {
    if (rec.itemId !== primaryId && rec.type && rec.value) {
      const cType = canonicalIdType(rec.type);
      if (!clearedCanonicalTypes.has(cType) && !desiredByType.has(cType)) {
        desiredByType.set(cType, { type: cType, value: rec.value, canonicalUri: rec.canonicalUri || rec.value });
      }
    }
  }
  if (!clearedCanonicalTypes.has('doi')) {
    const effectiveDoiRaw = topLevelData.doi ?? primaryMeta.doi ?? primaryDoi;
    if (typeof effectiveDoiRaw === 'string' && effectiveDoiRaw.trim()) {
      const cleanDoi = normalizeDoi(effectiveDoiRaw) || effectiveDoiRaw.trim();
      desiredByType.set('doi', { type: 'doi', value: cleanDoi, canonicalUri: `https://doi.org/${cleanDoi}` });
    } else {
      const discoveredDoi = desiredByType.get('doi')?.value;
      if (discoveredDoi && discoveredDoi.trim()) {
        const cleanDoi = normalizeDoi(discoveredDoi) || discoveredDoi.trim();
        topLevelData.doi = cleanDoi;
        primaryMeta.doi = cleanDoi;
        desiredByType.set('doi', { type: 'doi', value: cleanDoi, canonicalUri: `https://doi.org/${cleanDoi}` });
      }
    }
  }
  const idNormMap = {
    arxivId: { norm: normalizeArxivId, uri: (v: string) => `https://arxiv.org/abs/${v}` },
    pmid: { norm: normalizePmid, uri: (v: string) => `https://pubmed.ncbi.nlm.nih.gov/${v}/` },
    pmcid: { norm: normalizePmcid, uri: (v: string) => `https://www.ncbi.nlm.nih.gov/pmc/articles/${v}/` },
    isbn: { norm: normalizeIsbn, uri: (v: string) => `urn:isbn:${v}` },
    issn: { norm: normalizeIssn, uri: (v: string) => `urn:issn:${v}` },
  } as const;
  for (const key of IDENTIFIER_META_KEYS) {
    const canonicalType = key === 'arxivId' ? 'arxiv' : key;
    if (clearedCanonicalTypes.has(canonicalType)) {
      desiredByType.delete(canonicalType);
      delete primaryMeta[key];
      continue;
    }
    const rawVal = primaryMeta[key];
    if (typeof rawVal === 'string' && rawVal.trim()) {
      const cleanVal = idNormMap[key].norm(rawVal) || rawVal.trim();
      desiredByType.set(canonicalType, { type: canonicalType, value: cleanVal, canonicalUri: idNormMap[key].uri(cleanVal) });
    } else {
      const discovered = desiredByType.get(canonicalType)?.value;
      if (discovered && discovered.trim()) {
        const cleanVal = idNormMap[key].norm(discovered) || discovered.trim();
        primaryMeta[key] = cleanVal;
        desiredByType.set(canonicalType, { type: canonicalType, value: cleanVal, canonicalUri: idNormMap[key].uri(cleanVal) });
      }
    }
  }
  return desiredByType;
}

export function applyMetadataAndProvenanceBackfill(params: {
  primary: Record<string, unknown> & { id: string; citationKey?: string | null; metadata?: unknown };
  duplicates: Array<Record<string, unknown> & { id: string; citationKey?: string | null; doi?: string | null; metadata?: unknown; contributors?: unknown }>;
  scalarSelections: Record<string, unknown>;
  primaryMeta: Record<string, unknown>;
  backfillFields: Record<string, unknown>;
  extraObj?: Record<string, unknown>;
}): void {
  const { primary, duplicates, scalarSelections, primaryMeta, backfillFields, extraObj } = params;
  const { lockedSet: primaryLockedSet, provenanceMap: primaryProvenance } =
    ItemProvenancePolicy.extractProvenanceState(primaryMeta);
  const createManualProvenance = (): FieldProvenanceRecord => ({
    ...ItemProvenancePolicy.createUserOverrideRecord(), lockedByUser: true, isFilenameTitle: false,
  });

  for (const [selKey, selVal] of Object.entries(scalarSelections)) {
    if (selVal === undefined || selKey === 'extraFields' || selKey === 'metadata' || SYSTEM_RESERVED_MERGE_KEYS.has(selKey)) continue;
    if (selVal === '' || selVal === null) {
      primaryLockedSet.delete(selKey);
      delete primaryProvenance[selKey];
      for (const alias of ItemProvenancePolicy.getCoupledFieldAliases(selKey)) {
        primaryLockedSet.delete(alias);
        delete primaryProvenance[alias];
      }
      continue;
    }
    const manualProv = createManualProvenance();
    primaryProvenance[selKey] = manualProv;
    primaryLockedSet.add(selKey);
    for (const alias of ItemProvenancePolicy.getCoupledFieldAliases(selKey)) {
      primaryProvenance[alias] = { ...manualProv };
      primaryLockedSet.add(alias);
    }
  }

  for (const field of ALLOWED_MERGE_METADATA_FIELDS) {
    if (field === 'extra' || scalarSelections[field] !== undefined) continue;
    const sortedDupsForField = [...duplicates].sort(
      (a, b) => ItemProvenancePolicy.getFieldAuthority(b, field, true) - ItemProvenancePolicy.getFieldAuthority(a, field, true),
    );
    if (!primaryLockedSet.has(field)) {
      let promotedFromLockedDup = false;
      for (const dup of sortedDupsForField) {
        const dupMeta = asMetaObject(dup.metadata);
        const lockCheck = ItemProvenancePolicy.inspectFieldUserLock(dupMeta, field);
        if (lockCheck.locked) {
          const dupVal = getEffectiveItemField(dup, field, dupMeta, { excludeGenericsFromSpecificTarget: true });
          if (dupVal !== undefined) {
            backfillFields[field] = dupVal;
            primaryLockedSet.add(field);
            if (lockCheck.provenance) primaryProvenance[field] = lockCheck.provenance;
            promotedFromLockedDup = true;
            break;
          }
        }
      }
      if (promotedFromLockedDup) continue;
    }

    const isPreprintVenueString = (v: unknown): boolean =>
      typeof v === 'string' && PREPRINT_SERVER_VENUE_REGEX.test(v.trim());
    const existingPrimaryVal = getEffectiveItemField(primary, field, primaryMeta, { excludeGenericsFromSpecificTarget: true });
    const isPrimaryPlaceholderTitle =
      field === 'title' &&
      !primaryLockedSet.has('title') &&
      (isPlaceholderItemTitle(String(primary.title || '')) ||
        primaryMeta.isFilenameTitle === true ||
        primaryProvenance.title?.isFilenameTitle === true);
    const isPrimaryPreprintVenue =
      (field === 'publicationTitle' || field === 'journal') &&
      !primaryLockedSet.has('publicationTitle') &&
      !primaryLockedSet.has('journal') &&
      isPreprintVenueString(existingPrimaryVal);

    if (existingPrimaryVal === undefined || isPrimaryPlaceholderTitle || isPrimaryPreprintVenue) {
      const primaryFieldAuth = isPrimaryPreprintVenue ? ItemProvenancePolicy.getFieldAuthority(primary, field, true) : 0;
      for (const dup of sortedDupsForField) {
        const dupMeta = asMetaObject(dup.metadata);
        const dupVal = getEffectiveItemField(dup, field, dupMeta, { excludeGenericsFromSpecificTarget: true });
        if (dupVal !== undefined) {
          if (field === 'title' && (isPlaceholderItemTitle(String(dupVal)) || dupMeta.isFilenameTitle === true)) continue;
          if (isPrimaryPreprintVenue) {
            if (isPreprintVenueString(dupVal)) continue;
            if (ItemProvenancePolicy.getFieldAuthority(dup, field, true) < primaryFieldAuth) continue;
          }
          backfillFields[field] = dupVal;
          const dupProvMap =
            dupMeta.fieldProvenance && typeof dupMeta.fieldProvenance === 'object' && !Array.isArray(dupMeta.fieldProvenance)
              ? (dupMeta.fieldProvenance as Record<string, unknown>)
              : {};
          if (dupProvMap[field] && typeof dupProvMap[field] === 'object') {
            if (primaryProvenance[field] === undefined || isPrimaryPlaceholderTitle || isPrimaryPreprintVenue) {
              primaryProvenance[field] = { ...(dupProvMap[field] as FieldProvenanceRecord) };
            }
          }
          break;
        }
      }
    }
  }

  if (scalarSelections.title !== undefined || backfillFields.title !== undefined) {
    primaryMeta.isFilenameTitle = false;
    if (primaryProvenance.title && typeof primaryProvenance.title === 'object') {
      primaryProvenance.title = { ...primaryProvenance.title, isFilenameTitle: false };
    }
  }

  for (const idKey of IDENTIFIER_META_KEYS) {
    if (scalarSelections[idKey] !== undefined) {
      if (scalarSelections[idKey] === '' || scalarSelections[idKey] === null) {
        delete primaryMeta[idKey];
        for (const alias of ItemProvenancePolicy.getCoupledFieldAliases(idKey)) delete primaryMeta[alias];
      } else {
        primaryMeta[idKey] = scalarSelections[idKey];
      }
      continue;
    }
    if (primaryMeta[idKey] === undefined || primaryMeta[idKey] === null || primaryMeta[idKey] === '') {
      const topOnPrimary = getEffectiveItemField(primary, idKey, primaryMeta);
      if (topOnPrimary !== undefined) {
        primaryMeta[idKey] = topOnPrimary;
      } else {
        const sortedDupsForId = [...duplicates].sort(
          (a, b) => ItemProvenancePolicy.getFieldAuthority(b, idKey, true) - ItemProvenancePolicy.getFieldAuthority(a, idKey, true),
        );
        for (const dup of sortedDupsForId) {
          const dupMeta = asMetaObject(dup.metadata);
          const candidateVal = getEffectiveItemField(dup, idKey, dupMeta);
          if (candidateVal !== undefined) {
            primaryMeta[idKey] = candidateVal;
            backfillFields[idKey] = candidateVal;
            const lockCheck = ItemProvenancePolicy.inspectFieldUserLock(dupMeta, idKey);
            if (lockCheck.locked) primaryLockedSet.add(idKey);
            if (lockCheck.provenance && primaryProvenance[idKey] === undefined) primaryProvenance[idKey] = lockCheck.provenance;
            break;
          }
        }
      }
    }
  }

  if (primaryLockedSet.size > 0 || Array.isArray(primaryMeta.lockedFields)) {
    primaryMeta.lockedFields = Array.from(primaryLockedSet);
  }
  if (Object.keys(primaryProvenance).length > 0 || primaryMeta.fieldProvenance !== undefined) {
    primaryMeta.fieldProvenance = primaryProvenance;
  }

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
    pushExtraLines(primary.extra);
    for (const dup of duplicates) {
      pushExtraLines(asMetaObject(dup.metadata).extra);
      pushExtraLines(dup.extra);
    }
    if (extraLines.length > 0 && !extraObj) primaryMeta.extra = extraLines.join('\n');
    else if (extraObj) primaryMeta.extra = extraObj;
  }
}

export function computeMergedTopLevelAndPrimaryMeta(params: {
  primary: Record<string, unknown>;
  effectiveMergedItemType?: string;
  derivedFirstAuthor?: string | null;
  finalContributors?: Array<Record<string, unknown>>;
  noteCount?: number;
  attachmentCount?: number;
  backfillFields: Record<string, unknown>;
  scalarSelections: Record<string, unknown>;
  primaryMeta: Record<string, unknown>;
}): Record<string, unknown> {
  const {
    primary, effectiveMergedItemType, derivedFirstAuthor, finalContributors,
    noteCount, attachmentCount, backfillFields, scalarSelections, primaryMeta,
  } = params;
  const hasNonEmpty = (v: unknown): boolean => v !== undefined && v !== null && String(v).trim() !== '';
  const isEmptyClear = (v: unknown): boolean => v === null || (typeof v === 'string' && v.trim() === '');
  const origPrimaryMeta = asMetaObject(primary.metadata);
  const combinedUpdates: Record<string, unknown> = { ...backfillFields, ...scalarSelections };
  const resolvedItemType = String(
    scalarSelections.itemType || effectiveMergedItemType || primary.itemType || primary.type || 'journalArticle',
  );
  const computedFirstAuthor =
    Array.isArray(finalContributors) && finalContributors.length > 0
      ? deriveFirstAuthor({ contributors: finalContributors, itemType: resolvedItemType })
      : derivedFirstAuthor;
  const topLevelData: Record<string, unknown> = {
    itemType: resolvedItemType,
    ...(computedFirstAuthor !== undefined ? { firstAuthor: computedFirstAuthor } : {}),
    ...(noteCount !== undefined ? { noteCount } : {}),
    ...(attachmentCount !== undefined ? { attachmentCount, hasFile: attachmentCount > 0 } : {}),
  };

  for (const [key, val] of Object.entries(combinedUpdates)) {
    if (key === 'extraFields' || key === 'metadata' || SYSTEM_RESERVED_MERGE_KEYS.has(key)) continue;
    if (TOP_LEVEL_ITEM_COLUMNS.has(key)) {
      if (isEmptyClear(val)) {
        topLevelData[key] = key === 'title' ? (primary.title ?? 'Untitled Item') : null;
        delete primaryMeta[key];
      } else if (key === 'year') {
        const numYear = typeof val === 'number' ? val : parseInt(String(val), 10);
        topLevelData.year = Number.isNaN(numYear) ? null : numYear;
      } else {
        topLevelData[key] = val;
      }
    } else if (isEmptyClear(val)) {
      delete primaryMeta[key];
    } else {
      primaryMeta[key] = val;
    }
  }

  const primaryHasAbstract = hasNonEmpty(primary.abstract) || hasNonEmpty(origPrimaryMeta.abstractNote);
  const abstractAliasAuthorized =
    scalarSelections.abstract !== undefined ||
    scalarSelections.abstractNote !== undefined ||
    (backfillFields.abstractNote !== undefined &&
      ItemProvenancePolicy.isFieldLocked(primaryMeta, 'abstractNote') &&
      !ItemProvenancePolicy.isFieldLocked(origPrimaryMeta, 'abstract'));
  const effectiveAbstract =
    topLevelData.abstract !== undefined
      ? topLevelData.abstract
      : scalarSelections.abstractNote !== undefined
        ? scalarSelections.abstractNote
        : backfillFields.abstractNote !== undefined && (!primaryHasAbstract || abstractAliasAuthorized)
          ? backfillFields.abstractNote
          : undefined;
  if (effectiveAbstract !== undefined) {
    if (isEmptyClear(effectiveAbstract)) {
      topLevelData.abstract = null;
      delete primaryMeta.abstractNote;
      delete primaryMeta.abstract;
    } else {
      topLevelData.abstract = effectiveAbstract;
      primaryMeta.abstractNote = effectiveAbstract;
      delete primaryMeta.abstract;
    }
  } else if (hasNonEmpty(primary.abstract)) {
    primaryMeta.abstractNote = primary.abstract;
    delete primaryMeta.abstract;
  }

  const rawOrigVenue = String(primary.publicationTitle || origPrimaryMeta.publicationTitle || origPrimaryMeta.journal || '').trim();
  const isOrigPreprintVenue = PREPRINT_SERVER_VENUE_REGEX.test(rawOrigVenue);
  const primaryHasPubTitle =
    Boolean(rawOrigVenue) && (!isOrigPreprintVenue || ItemProvenancePolicy.isFieldLocked(origPrimaryMeta, 'publicationTitle'));
  const selectedVenueAlias = VENUE_ALIAS_MERGE_KEYS.map((k) => scalarSelections[k]).find((v) => v !== undefined);
  const backfillVenueAlias = VENUE_ALIAS_MERGE_KEYS.map((k) => backfillFields[k]).find((v) => v !== undefined);
  const journalAliasAuthorized =
    scalarSelections.journal !== undefined ||
    (backfillFields.journal !== undefined &&
      ItemProvenancePolicy.isFieldLocked(primaryMeta, 'journal') &&
      !ItemProvenancePolicy.isFieldLocked(origPrimaryMeta, 'publicationTitle'));
  const venueAliasAuthorized =
    selectedVenueAlias !== undefined ||
    (backfillVenueAlias !== undefined &&
      VENUE_ALIAS_MERGE_KEYS.some((k) => backfillFields[k] !== undefined && ItemProvenancePolicy.isFieldLocked(primaryMeta, k)) &&
      !ItemProvenancePolicy.isFieldLocked(origPrimaryMeta, 'publicationTitle'));
  const effectivePubTitle =
    topLevelData.publicationTitle !== undefined
      ? topLevelData.publicationTitle
      : scalarSelections.journal !== undefined
        ? scalarSelections.journal
        : selectedVenueAlias !== undefined
          ? selectedVenueAlias
          : backfillFields.journal !== undefined && (!primaryHasPubTitle || journalAliasAuthorized)
            ? backfillFields.journal
            : backfillVenueAlias !== undefined && (!primaryHasPubTitle || venueAliasAuthorized)
              ? backfillVenueAlias
              : undefined;
  if (effectivePubTitle !== undefined) {
    if (isEmptyClear(effectivePubTitle)) {
      topLevelData.publicationTitle = null;
      delete primaryMeta.publicationTitle;
      delete primaryMeta.journal;
      delete primaryMeta.venue;
    } else {
      topLevelData.publicationTitle = effectivePubTitle;
      primaryMeta.publicationTitle = effectivePubTitle;
      if (combinedUpdates.journal !== undefined && !isEmptyClear(combinedUpdates.journal)) {
        primaryMeta.journal = combinedUpdates.journal;
      }
    }
  } else if (hasNonEmpty(primary.publicationTitle)) {
    primaryMeta.publicationTitle = primary.publicationTitle;
    if (backfillFields.journal !== undefined && scalarSelections.journal === undefined) {
      if (hasNonEmpty(origPrimaryMeta.journal)) primaryMeta.journal = origPrimaryMeta.journal;
      else delete primaryMeta.journal;
    }
  }

  const primaryHasYear = hasNonEmpty(primary.year);
  const dateExplicitlySelected = scalarSelections.date !== undefined || scalarSelections.publicationDate !== undefined;
  const dateLockedUpgrade =
    (backfillFields.date !== undefined || backfillFields.publicationDate !== undefined) &&
    (ItemProvenancePolicy.isFieldLocked(primaryMeta, 'date') || ItemProvenancePolicy.isFieldLocked(primaryMeta, 'publicationDate')) &&
    !ItemProvenancePolicy.isFieldLocked(origPrimaryMeta, 'year');

  if (
    topLevelData.year === null &&
    (isEmptyClear(scalarSelections.year) || isEmptyClear(scalarSelections.date) || isEmptyClear(scalarSelections.publicationDate))
  ) {
    delete primaryMeta.year;
    delete primaryMeta.date;
    delete primaryMeta.publicationDate;
  } else if (topLevelData.year !== undefined && combinedUpdates.date === undefined && combinedUpdates.publicationDate === undefined) {
    const yearStr = topLevelData.year != null ? String(topLevelData.year) : '';
    const existingDate = String(primaryMeta.date ?? primaryMeta.publicationDate ?? '').trim();
    if (!existingDate || /^\d{4}$/.test(existingDate)) {
      primaryMeta.date = yearStr;
      primaryMeta.publicationDate = yearStr;
    }
  } else if (combinedUpdates.date !== undefined || combinedUpdates.publicationDate !== undefined) {
    const rawDateInput = combinedUpdates.publicationDate ?? combinedUpdates.date;
    if (isEmptyClear(rawDateInput)) {
      delete primaryMeta.date;
      delete primaryMeta.publicationDate;
      if (topLevelData.year === undefined && dateExplicitlySelected) {
        topLevelData.year = null;
        delete primaryMeta.year;
      }
    } else {
      const chosenDate = String(rawDateInput ?? '').trim();
      const m = chosenDate.match(/(?:^|[^\d])(1\d{3}|20\d{2})(?:[^\d]|$)/);
      const parsedYear = m ? parseInt(m[1], 10) : undefined;
      if (!primaryHasYear || dateExplicitlySelected || dateLockedUpgrade) {
        primaryMeta.date = chosenDate;
        primaryMeta.publicationDate = chosenDate;
        if (topLevelData.year === undefined && parsedYear !== undefined) topLevelData.year = parsedYear;
      } else if (parsedYear === undefined || parsedYear === Number(primary.year)) {
        primaryMeta.date = chosenDate;
        primaryMeta.publicationDate = chosenDate;
      } else {
        if (hasNonEmpty(origPrimaryMeta.date)) primaryMeta.date = origPrimaryMeta.date;
        else delete primaryMeta.date;
        if (hasNonEmpty(origPrimaryMeta.publicationDate)) primaryMeta.publicationDate = origPrimaryMeta.publicationDate;
        else delete primaryMeta.publicationDate;
      }
    }
  }

  if (topLevelData.doi !== undefined) {
    if (isEmptyClear(topLevelData.doi)) {
      topLevelData.doi = null;
      delete primaryMeta.doi;
      delete primaryMeta.DOI;
    } else {
      const cleanDoi = typeof topLevelData.doi === 'string' ? normalizeDoi(topLevelData.doi) || topLevelData.doi : topLevelData.doi;
      topLevelData.doi = cleanDoi;
      primaryMeta.doi = cleanDoi;
      delete primaryMeta.DOI;
    }
  }

  if (topLevelData.url !== undefined) {
    if (isEmptyClear(topLevelData.url)) {
      topLevelData.url = null;
      delete primaryMeta.url;
      delete primaryMeta.URL;
    } else {
      primaryMeta.url = topLevelData.url;
      delete primaryMeta.URL;
    }
  }

  if (topLevelData.citationKey !== undefined && isEmptyClear(topLevelData.citationKey)) {
    topLevelData.citationKey = null;
    delete primaryMeta.citationKey;
    delete primaryMeta.citeKey;
  }

  return topLevelData;
}
