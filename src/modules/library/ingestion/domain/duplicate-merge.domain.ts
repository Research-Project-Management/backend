import { Prisma } from '@prisma/client';
import {
  asMetaObject,
} from '@/modules/library/ingestion/services/duplicate-detector.service';
import {
  normalizeDoi,
  PRISMA_ITEM_SCALAR_COLUMNS,
  ItemProvenancePolicy,
} from '@/modules/library/core';
import { deriveFirstAuthor } from '@/modules/library/catalog/catalog.facade';
import {
  ContributorShape,
  IDENTIFIER_META_KEYS,
  syncMergedContributors,
  syncMergedIdentifiersInTx,
} from './duplicate-merge-contributors.domain';

export {
  ContributorShape,
  IDENTIFIER_META_KEYS,
  syncMergedContributors,
  syncMergedIdentifiersInTx,
};

const INVERSE_RELATION_TYPE_MAP: Readonly<Record<string, string>> = {
  cites: 'cited_by',
  cited_by: 'cites',
  is_preprint_of: 'is_published_version_of',
  is_published_version_of: 'is_preprint_of',
  is_supplement_to: 'has_supplement',
  has_supplement: 'is_supplement_to',
  is_part_of: 'has_part',
  has_part: 'is_part_of',
  related_to: 'related_to',
  related: 'related',
};

function registerRelationPairWithReciprocal(
  pairSet: Set<string>,
  sourceId: string,
  targetId: string,
  relationType: string,
): void {
  pairSet.add(`${sourceId}::${targetId}::${relationType}`);
  const inverseType = INVERSE_RELATION_TYPE_MAP[relationType];
  if (inverseType) {
    pairSet.add(`${targetId}::${sourceId}::${inverseType}`);
  }
}

export const VENUE_ALIAS_MERGE_KEYS = [
  'proceedingsTitle',
  'bookTitle',
  'encyclopediaTitle',
  'dictionaryTitle',
  'blogTitle',
  'forumTitle',
  'websiteTitle',
  'programTitle',
  'repository',
] as const;

export const SYSTEM_RESERVED_MERGE_KEYS = new Set([
  'id',
  'userId',
  'projectId',
  'deletedAt',
  'createdAt',
  'updatedAt',
  'version',
  'attachmentCount',
  'noteCount',
  'hasFile',
  'normalizedTitle',
  'searchVector',
  'firstAuthor',
  'isRetracted',
  'retraction',
  'retractionDate',
  'retractionNature',
  'retractionDetails',
  'retractionCheckedAt',
  'retractionReasons',
  'retractionNoticeDoi',
  'retractionSource',
  'mergeHistory',
  'fieldProvenance',
  'lockedFields',
  'dismissedDuplicateIds',
  'mergedCitationKeys',
  'metadata',
  'lastMergeMemento',
  'mergedIntoId',
  'mergedAt',
  'mergedFromIds',
  '__proto__',
  'constructor',
  'prototype',
]);

export const TOP_LEVEL_ITEM_COLUMNS = new Set<string>(PRISMA_ITEM_SCALAR_COLUMNS);
export const RETRACTION_SURVIVAL_KEYS = [
  'isRetracted',
  'retraction',
  'retractionDate',
  'retractionNature',
  'retractionDetails',
  'retractionCheckedAt',
  'retractionReasons',
  'retractionNoticeDoi',
  'retractionSource',
] as const;

export async function rewireMergedItemRelations(
  tx: Prisma.TransactionClient,
  primaryId: string,
  uniqueDupIds: string[],
): Promise<Array<Record<string, unknown>>> {
  const existingRelations = (await tx.itemRelation?.findMany?.({
    where: {
      OR: [
        { sourceItemId: { in: [primaryId, ...uniqueDupIds] } },
        { targetItemId: { in: [primaryId, ...uniqueDupIds] } },
      ],
    },
  })) ?? [];

  const primaryExistingPairs = new Set<string>();
  for (const rel of existingRelations) {
    if (
      (rel.sourceItemId === primaryId || rel.targetItemId === primaryId) &&
      !uniqueDupIds.includes(rel.sourceItemId) &&
      !uniqueDupIds.includes(rel.targetItemId)
    ) {
      registerRelationPairWithReciprocal(
        primaryExistingPairs,
        rel.sourceItemId,
        rel.targetItemId,
        rel.relationType,
      );
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
    if (newSourceId === newTargetId) {
      relationIdsToDelete.push(rel.id);
      continue;
    }

    const candidateKey = `${newSourceId}::${newTargetId}::${rel.relationType}`;
    if (primaryExistingPairs.has(candidateKey)) {
      relationIdsToDelete.push(rel.id);
    } else {
      relationUpdates.push({ id: rel.id, sourceItemId: newSourceId, targetItemId: newTargetId });
      registerRelationPairWithReciprocal(
        primaryExistingPairs,
        newSourceId,
        newTargetId,
        rel.relationType,
      );
    }
  }

  if (relationUpdates.length > 0) {
    await Promise.all(
      relationUpdates.map((upd) =>
        tx.itemRelation.update({
          where: { id: upd.id },
          data: { sourceItemId: upd.sourceItemId, targetItemId: upd.targetItemId },
        }),
      ),
    );
  }
  if (relationIdsToDelete.length > 0) {
    if (tx.itemRelation.deleteMany) {
      await tx.itemRelation.deleteMany({ where: { id: { in: relationIdsToDelete } } });
    } else {
      await Promise.all(
        relationIdsToDelete.map((relId) => tx.itemRelation.delete({ where: { id: relId } })),
      );
    }
  }
  return existingRelations as unknown as Array<Record<string, unknown>>;
}

export async function consolidateUserPublications(
  tx: Prisma.TransactionClient,
  primaryId: string,
  uniqueDupIds: string[],
): Promise<{
  dupPublications: Array<Record<string, unknown>>;
  primaryPublications: Array<Record<string, unknown>>;
}> {
  const dupPublications = (await tx.userPublication?.findMany?.({
    where: { itemId: { in: uniqueDupIds } },
  })) ?? [];
  if (dupPublications.length === 0) {
    return { dupPublications: [], primaryPublications: [] };
  }

  const primaryPubByUser = new Map<string, (typeof dupPublications)[number]>();
  const initialPrimaryPubs: Array<Record<string, unknown>> = [];

  for (const pub of dupPublications) {
    let existingPrimaryPub = primaryPubByUser.get(pub.userId) ?? null;
    if (!existingPrimaryPub && tx.userPublication.findUnique) {
      existingPrimaryPub = await tx.userPublication.findUnique({
        where: { userId_itemId: { userId: pub.userId, itemId: primaryId } },
      });
      if (existingPrimaryPub) {
        initialPrimaryPubs.push({ ...(existingPrimaryPub as unknown as Record<string, unknown>) });
      }
    }

    if (!existingPrimaryPub) {
      const created = await tx.userPublication.create({
        data: {
          userId: pub.userId,
          itemId: primaryId,
          contributorId: pub.contributorId,
          isPublic: pub.isPublic,
          openAccessLicense: pub.openAccessLicense,
          addedAt: pub.addedAt,
        },
      });
      primaryPubByUser.set(pub.userId, created ?? ({ ...pub, itemId: primaryId } as never));
    } else {
      const updatedData = {
        isPublic: existingPrimaryPub.isPublic || pub.isPublic,
        openAccessLicense: existingPrimaryPub.openAccessLicense || pub.openAccessLicense,
        contributorId: existingPrimaryPub.contributorId || pub.contributorId,
      };
      await tx.userPublication.update({
        where: { userId_itemId: { userId: pub.userId, itemId: primaryId } },
        data: updatedData,
      });
      primaryPubByUser.set(pub.userId, { ...existingPrimaryPub, ...updatedData });
    }
  }

  if (tx.userPublication.deleteMany) {
    await tx.userPublication.deleteMany({ where: { itemId: { in: uniqueDupIds } } });
  } else {
    for (const pub of dupPublications) {
      await tx.userPublication.delete({
        where: { userId_itemId: { userId: pub.userId, itemId: pub.itemId } },
      });
    }
  }

  return {
    dupPublications: dupPublications as unknown as Array<Record<string, unknown>>,
    primaryPublications: initialPrimaryPubs,
  };
}

export async function applyMergedUpdatesAndClearDuplicateCitationKeyCollision(params: {
  tx: Prisma.TransactionClient;
  primary: Record<string, unknown>;
  duplicates: Array<Record<string, unknown>>;
  effectiveMergedItemType?: string;
  derivedFirstAuthor?: string | null;
  finalContributors?: Array<Record<string, unknown>>;
  noteCount?: number;
  attachmentCount?: number;
  backfillFields: Record<string, unknown>;
  scalarSelections: Record<string, unknown>;
  primaryMeta: Record<string, unknown>;
}): Promise<{ topLevelData: Record<string, unknown> }> {
  const {
    tx,
    primary,
    duplicates,
    effectiveMergedItemType,
    derivedFirstAuthor,
    finalContributors,
    noteCount,
    attachmentCount,
    backfillFields,
    scalarSelections,
    primaryMeta,
  } = params;

  const hasNonEmpty = (v: unknown): boolean =>
    v !== undefined && v !== null && String(v).trim() !== '';
  const isEmptyClear = (v: unknown): boolean =>
    v === null || (typeof v === 'string' && v.trim() === '');
  const origPrimaryMeta = asMetaObject(primary.metadata);
  const combinedUpdates: Record<string, unknown> = { ...backfillFields, ...scalarSelections };
  const resolvedItemType = String(
    scalarSelections.itemType ||
      effectiveMergedItemType ||
      primary.itemType ||
      primary.type ||
      'journalArticle',
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
    if (key === 'extraFields' || key === 'metadata' || SYSTEM_RESERVED_MERGE_KEYS.has(key)) {
      continue;
    }
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

  const primaryHasAbstract =
    hasNonEmpty(primary.abstract) || hasNonEmpty(origPrimaryMeta.abstractNote);
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

  const rawOrigVenue = String(
    primary.publicationTitle || origPrimaryMeta.publicationTitle || origPrimaryMeta.journal || '',
  ).trim();
  const isOrigPreprintVenue =
    /^(?:arxiv(?:\.org)?|corr|biorxiv|medrxiv|chemrxiv|techrxiv|ssrn|research\s+square|osf\s+preprints|hal|zenodo)(?:\s+preprints?|\s+e-?prints?)?$/i.test(
      rawOrigVenue,
    );
  const primaryHasPubTitle =
    Boolean(rawOrigVenue) &&
    (!isOrigPreprintVenue ||
      ItemProvenancePolicy.isFieldLocked(origPrimaryMeta, 'publicationTitle'));
  const selectedVenueAlias = VENUE_ALIAS_MERGE_KEYS.map((k) => scalarSelections[k]).find(
    (v) => v !== undefined,
  );
  const backfillVenueAlias = VENUE_ALIAS_MERGE_KEYS.map((k) => backfillFields[k]).find(
    (v) => v !== undefined,
  );
  const journalAliasAuthorized =
    scalarSelections.journal !== undefined ||
    (backfillFields.journal !== undefined &&
      ItemProvenancePolicy.isFieldLocked(primaryMeta, 'journal') &&
      !ItemProvenancePolicy.isFieldLocked(origPrimaryMeta, 'publicationTitle'));
  const venueAliasAuthorized =
    selectedVenueAlias !== undefined ||
    (backfillVenueAlias !== undefined &&
      VENUE_ALIAS_MERGE_KEYS.some(
        (k) => backfillFields[k] !== undefined && ItemProvenancePolicy.isFieldLocked(primaryMeta, k),
      ) &&
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
      if (hasNonEmpty(origPrimaryMeta.journal)) {
        primaryMeta.journal = origPrimaryMeta.journal;
      } else {
        delete primaryMeta.journal;
      }
    }
  }

  const primaryHasYear = hasNonEmpty(primary.year);
  const dateExplicitlySelected =
    scalarSelections.date !== undefined || scalarSelections.publicationDate !== undefined;
  const dateLockedUpgrade =
    (backfillFields.date !== undefined || backfillFields.publicationDate !== undefined) &&
    (ItemProvenancePolicy.isFieldLocked(primaryMeta, 'date') ||
      ItemProvenancePolicy.isFieldLocked(primaryMeta, 'publicationDate')) &&
    !ItemProvenancePolicy.isFieldLocked(origPrimaryMeta, 'year');

  if (
    topLevelData.year === null &&
    (isEmptyClear(scalarSelections.year) ||
      isEmptyClear(scalarSelections.date) ||
      isEmptyClear(scalarSelections.publicationDate))
  ) {
    delete primaryMeta.year;
    delete primaryMeta.date;
    delete primaryMeta.publicationDate;
  } else if (
    topLevelData.year !== undefined &&
    combinedUpdates.date === undefined &&
    combinedUpdates.publicationDate === undefined
  ) {
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
        if (topLevelData.year === undefined && parsedYear !== undefined) {
          topLevelData.year = parsedYear;
        }
      } else if (parsedYear === undefined || parsedYear === Number(primary.year)) {
        primaryMeta.date = chosenDate;
        primaryMeta.publicationDate = chosenDate;
      } else {
        if (hasNonEmpty(origPrimaryMeta.date)) {
          primaryMeta.date = origPrimaryMeta.date;
        } else {
          delete primaryMeta.date;
        }
        if (hasNonEmpty(origPrimaryMeta.publicationDate)) {
          primaryMeta.publicationDate = origPrimaryMeta.publicationDate;
        } else {
          delete primaryMeta.publicationDate;
        }
      }
    }
  }

  if (topLevelData.doi !== undefined) {
    if (isEmptyClear(topLevelData.doi)) {
      topLevelData.doi = null;
      delete primaryMeta.doi;
      delete primaryMeta.DOI;
    } else {
      const cleanDoi =
        typeof topLevelData.doi === 'string'
          ? normalizeDoi(topLevelData.doi) || topLevelData.doi
          : topLevelData.doi;
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

  if (typeof topLevelData.citationKey === 'string' && topLevelData.citationKey.trim()) {
    const targetCitKey = topLevelData.citationKey.trim().toLowerCase();
    for (const dup of duplicates) {
      const dupCitKey =
        typeof dup.citationKey === 'string' ? dup.citationKey.trim().toLowerCase() : '';
      if (dupCitKey && dupCitKey === targetCitKey && typeof dup.id === 'string') {
        await tx.item.update({ where: { id: dup.id }, data: { citationKey: null } });
      }
    }
  }

  return { topLevelData };
}
