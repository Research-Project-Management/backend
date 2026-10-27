import { Prisma } from '@prisma/client';
import {
  ALLOWED_MERGE_METADATA_FIELDS,
  PrismaMergeAuditTrail,
} from '@/modules/library/ingestion/types/curation.types';
import {
  asMetaObject,
  getEffectiveItemField,
} from '@/modules/library/ingestion/services/duplicate-detector.service';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  parseCreatorString,
  PRISMA_ITEM_SCALAR_COLUMNS,
} from '@/modules/library/core';

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

export interface ContributorShape {
  creatorType?: string;
  fieldMode?: number;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  shortName?: string | null;
  name?: string;
  orderIndex?: number;
}

export const SYSTEM_RESERVED_MERGE_KEYS = new Set([
  'id',
  'userId',
  'projectId',
  'deletedAt',
  'createdAt',
  'updatedAt',
  'version',
]);

export const TOP_LEVEL_ITEM_COLUMNS = new Set<string>(
  PRISMA_ITEM_SCALAR_COLUMNS,
);

export const IDENTIFIER_META_KEYS = [
  'arxivId',
  'pmid',
  'pmcid',
  'isbn',
  'issn',
] as const;

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
    if (rel.sourceItemId === primaryId || rel.targetItemId === primaryId) {
      primaryExistingPairs.add(
        `${rel.sourceItemId}::${rel.targetItemId}::${rel.relationType}`,
      );
    }
  }

  const relationIdsToDelete: string[] = [];
  const relationUpdates: Array<{
    id: string;
    sourceItemId: string;
    targetItemId: string;
  }> = [];

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
      relationUpdates.push({
        id: rel.id,
        sourceItemId: newSourceId,
        targetItemId: newTargetId,
      });
      primaryExistingPairs.add(candidateKey);
    }
  }

  if (relationUpdates.length > 0) {
    await Promise.all(
      relationUpdates.map((upd) =>
        tx.itemRelation.update({
          where: { id: upd.id },
          data: {
            sourceItemId: upd.sourceItemId,
            targetItemId: upd.targetItemId,
          },
        }),
      ),
    );
  }

  if (relationIdsToDelete.length > 0) {
    if (tx.itemRelation.deleteMany) {
      await tx.itemRelation.deleteMany({
        where: { id: { in: relationIdsToDelete } },
      });
    } else {
      await Promise.all(
        relationIdsToDelete.map((relId) =>
          tx.itemRelation.delete({ where: { id: relId } }),
        ),
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
        where: {
          userId_itemId: { userId: pub.userId, itemId: primaryId },
        },
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
      primaryPubByUser.set(
        pub.userId,
        created ?? ({ ...pub, itemId: primaryId } as never),
      );
    } else {
      const updatedData = {
        isPublic: existingPrimaryPub.isPublic || pub.isPublic,
        openAccessLicense:
          existingPrimaryPub.openAccessLicense || pub.openAccessLicense,
        contributorId:
          existingPrimaryPub.contributorId || pub.contributorId,
      };
      await tx.userPublication.update({
        where: {
          userId_itemId: { userId: pub.userId, itemId: primaryId },
        },
        data: updatedData,
      });
      primaryPubByUser.set(pub.userId, {
        ...existingPrimaryPub,
        ...updatedData,
      });
    }
  }

  if (tx.userPublication.deleteMany) {
    await tx.userPublication.deleteMany({
      where: { itemId: { in: uniqueDupIds } },
    });
  } else {
    for (const pub of dupPublications) {
      await tx.userPublication.delete({
        where: {
          userId_itemId: { userId: pub.userId, itemId: pub.itemId },
        },
      });
    }
  }

  return {
    dupPublications: dupPublications as unknown as Array<Record<string, unknown>>,
    primaryPublications: initialPrimaryPubs,
  };
}

export async function syncMergedContributors(
  tx: Prisma.TransactionClient,
  primaryId: string,
  chosenContributors: ContributorShape[] | string[] | undefined,
  duplicates: Array<{ contributors?: unknown }>,
): Promise<Array<Record<string, unknown>>> {
  const mapContributorInput = (c: ContributorShape | string, idx: number) => {
    const cObj = typeof c === 'object' && c !== null ? c : null;
    const creatorType = cObj?.creatorType || 'author';
    let firstName = (cObj?.firstName || '').trim();
    let lastName = (cObj?.lastName || '').trim();
    let fullName = (
      cObj?.fullName ||
      cObj?.name ||
      [firstName, lastName].filter(Boolean).join(' ') ||
      (typeof c === 'string' ? c : '')
    ).trim();
    if (!firstName && !lastName && fullName) {
      const parsed = parseCreatorString(fullName, idx, creatorType as never);
      firstName = parsed.firstName || '';
      lastName = parsed.lastName || '';
      fullName = parsed.fullName || fullName;
    }
    return {
      itemId: primaryId,
      creatorType,
      fieldMode: cObj?.fieldMode ?? 0,
      firstName,
      lastName,
      fullName,
      shortName: cObj?.shortName ?? '',
      orderIndex: cObj?.orderIndex ?? idx,
    };
  };

  if (Array.isArray(chosenContributors) && chosenContributors.length > 0) {
    await tx.contributor.deleteMany({ where: { itemId: primaryId } });
    const data = chosenContributors.map(mapContributorInput);
    await tx.contributor.createMany({ data });
    return data;
  }

  const primaryContribCount = await tx.contributor.count({
    where: { itemId: primaryId },
  });
  if (primaryContribCount === 0) {
    const donor = duplicates.find(
      (d) => Array.isArray(d.contributors) && d.contributors.length > 0,
    );
    if (donor && Array.isArray(donor.contributors)) {
      const data = (donor.contributors as ContributorShape[]).map(
        mapContributorInput,
      );
      await tx.contributor.createMany({ data });
      return data;
    }
  }
  return [];
}

export async function applyMergedUpdatesAndClearDuplicateCitationKeyCollision(params: {
  tx: Prisma.TransactionClient;
  primary: Record<string, unknown>;
  duplicates: Array<Record<string, unknown>>;
  effectiveMergedItemType: string;
  derivedFirstAuthor: string | null | undefined;
  noteCount: number | undefined;
  attachmentCount: number | undefined;
  backfillFields: Record<string, unknown>;
  scalarSelections: Record<string, unknown>;
  primaryMeta: Record<string, unknown>;
}): Promise<{ topLevelData: Record<string, unknown> }> {
  const {
    tx,
    duplicates,
    effectiveMergedItemType,
    derivedFirstAuthor,
    noteCount,
    attachmentCount,
    backfillFields,
    scalarSelections,
    primaryMeta,
  } = params;

  const combinedUpdates: Record<string, unknown> = {
    ...backfillFields,
    ...scalarSelections,
  };
  const topLevelData: Record<string, unknown> = {
    itemType: effectiveMergedItemType,
    ...(derivedFirstAuthor ? { firstAuthor: derivedFirstAuthor } : {}),
    ...(noteCount !== undefined ? { noteCount } : {}),
    ...(attachmentCount !== undefined
      ? { attachmentCount, hasFile: attachmentCount > 0 }
      : {}),
  };

  for (const [key, val] of Object.entries(combinedUpdates)) {
    if (TOP_LEVEL_ITEM_COLUMNS.has(key)) {
      topLevelData[key] = val;
    } else {
      primaryMeta[key] = val;
    }
  }

  // Synchronize dual-storage fields between topLevelData and primaryMeta
  const effectiveAbstract =
    topLevelData.abstract !== undefined
      ? topLevelData.abstract
      : combinedUpdates.abstractNote;
  if (effectiveAbstract !== undefined) {
    topLevelData.abstract = effectiveAbstract;
    primaryMeta.abstractNote = effectiveAbstract;
    delete primaryMeta.abstract;
  }

  const venueAliasCandidate = VENUE_ALIAS_MERGE_KEYS.map(
    (k) => combinedUpdates[k],
  ).find((v) => v !== undefined);
  const effectivePubTitle =
    topLevelData.publicationTitle !== undefined
      ? topLevelData.publicationTitle
      : combinedUpdates.journal !== undefined
        ? combinedUpdates.journal
        : venueAliasCandidate;
  if (effectivePubTitle !== undefined) {
    topLevelData.publicationTitle = effectivePubTitle;
    primaryMeta.publicationTitle = effectivePubTitle;
    if (combinedUpdates.journal !== undefined) {
      primaryMeta.journal = combinedUpdates.journal;
    }
  }

  if (
    topLevelData.year !== undefined &&
    combinedUpdates.date === undefined &&
    combinedUpdates.publicationDate === undefined
  ) {
    const yearStr = topLevelData.year != null ? String(topLevelData.year) : '';
    const existingDate = String(
      primaryMeta.date ?? primaryMeta.publicationDate ?? '',
    ).trim();
    if (!existingDate || /^\d{4}$/.test(existingDate)) {
      primaryMeta.date = yearStr;
      primaryMeta.publicationDate = yearStr;
    }
  } else if (
    combinedUpdates.date !== undefined ||
    combinedUpdates.publicationDate !== undefined
  ) {
    const chosenDate = String(
      combinedUpdates.publicationDate ?? combinedUpdates.date ?? '',
    ).trim();
    primaryMeta.date = chosenDate;
    primaryMeta.publicationDate = chosenDate;
    if (topLevelData.year === undefined && chosenDate) {
      const m = chosenDate.match(/(?:^|[^\d])(1\d{3}|20\d{2})(?:[^\d]|$)/);
      if (m) topLevelData.year = parseInt(m[1], 10);
    }
  }

  if (topLevelData.doi !== undefined) {
    const cleanDoi =
      typeof topLevelData.doi === 'string'
        ? normalizeDoi(topLevelData.doi) || topLevelData.doi
        : topLevelData.doi;
    topLevelData.doi = cleanDoi;
    primaryMeta.doi = cleanDoi;
    delete primaryMeta.DOI;
  }

  if (topLevelData.url !== undefined) {
    primaryMeta.url = topLevelData.url;
    delete primaryMeta.URL;
  }

  if (
    typeof topLevelData.citationKey === 'string' &&
    topLevelData.citationKey.trim()
  ) {
    const rawCitKey = topLevelData.citationKey.trim();
    const targetCitKey = rawCitKey.toLowerCase();
    for (const dup of duplicates) {
      const dupCitKey =
        typeof dup.citationKey === 'string'
          ? dup.citationKey.trim().toLowerCase()
          : '';
      if (dupCitKey && dupCitKey === targetCitKey && typeof dup.id === 'string') {
        await tx.item.update({
          where: { id: dup.id },
          data: { citationKey: null },
        });
      }
    }
  }

  return { topLevelData };
}

export async function syncMergedIdentifiersInTx(params: {
  tx: Prisma.TransactionClient;
  primaryId: string;
  uniqueDupIds: string[];
  primaryMeta: Record<string, unknown>;
  topLevelData: Record<string, unknown>;
  primaryDoi?: string | null;
}): Promise<void> {
  const { tx, primaryId, uniqueDupIds, primaryMeta, topLevelData, primaryDoi } =
    params;
  const identTx = tx as unknown as {
    itemIdentifier?: {
      findMany?: (args: {
        where: { itemId: { in: string[] } };
      }) => Promise<
        Array<{
          itemId: string;
          type: string;
          value: string;
          canonicalUri?: string | null;
        }>
      >;
      upsert?: (args: {
        where: { itemId_type: { itemId: string; type: string } };
        update: { value: string; canonicalUri: string };
        create: {
          itemId: string;
          type: string;
          value: string;
          canonicalUri: string;
        };
      }) => Promise<unknown>;
      deleteMany?: (args: {
        where: { itemId: { in: string[] } };
      }) => Promise<unknown>;
    };
  };
  if (!identTx.itemIdentifier) return;

  const existingIdRecords = identTx.itemIdentifier.findMany
    ? await identTx.itemIdentifier.findMany({
        where: { itemId: { in: [primaryId, ...uniqueDupIds] } },
      })
    : [];

  const canonicalIdType = (t: string) =>
    t === 'arxivId' || t.toLowerCase() === 'arxivid' ? 'arxiv' : t;

  const desiredByType = new Map<
    string,
    { type: string; value: string; canonicalUri: string }
  >();
  for (const rec of existingIdRecords) {
    if (rec.itemId === primaryId && rec.type && rec.value) {
      const cType = canonicalIdType(rec.type);
      desiredByType.set(cType, {
        type: cType,
        value: rec.value,
        canonicalUri: rec.canonicalUri || rec.value,
      });
    }
  }
  for (const rec of existingIdRecords) {
    if (rec.itemId !== primaryId && rec.type && rec.value) {
      const cType = canonicalIdType(rec.type);
      if (!desiredByType.has(cType)) {
        desiredByType.set(cType, {
          type: cType,
          value: rec.value,
          canonicalUri: rec.canonicalUri || rec.value,
        });
      }
    }
  }

  const effectiveDoiRaw = topLevelData.doi ?? primaryMeta.doi ?? primaryDoi;
  if (typeof effectiveDoiRaw === 'string' && effectiveDoiRaw.trim()) {
    const cleanDoi = normalizeDoi(effectiveDoiRaw) || effectiveDoiRaw.trim();
    desiredByType.set('doi', {
      type: 'doi',
      value: cleanDoi,
      canonicalUri: `https://doi.org/${cleanDoi}`,
    });
  }

  const idNormMap = {
    arxivId: {
      norm: normalizeArxivId,
      uri: (v: string) => `https://arxiv.org/abs/${v}`,
    },
    pmid: {
      norm: normalizePmid,
      uri: (v: string) => `https://pubmed.ncbi.nlm.nih.gov/${v}/`,
    },
    pmcid: {
      norm: normalizePmcid,
      uri: (v: string) => `https://www.ncbi.nlm.nih.gov/pmc/articles/${v}/`,
    },
    isbn: { norm: normalizeIsbn, uri: (v: string) => `urn:isbn:${v}` },
    issn: { norm: normalizeIssn, uri: (v: string) => `urn:issn:${v}` },
  } as const;

  for (const key of IDENTIFIER_META_KEYS) {
    const rawVal = primaryMeta[key];
    if (typeof rawVal === 'string' && rawVal.trim()) {
      const cleanVal = idNormMap[key].norm(rawVal) || rawVal.trim();
      const canonicalType = key === 'arxivId' ? 'arxiv' : key;
      desiredByType.set(canonicalType, {
        type: canonicalType,
        value: cleanVal,
        canonicalUri: idNormMap[key].uri(cleanVal),
      });
    }
  }

  if (identTx.itemIdentifier.upsert) {
    await Promise.all(
      Array.from(desiredByType.values(), (idObj) =>
        identTx.itemIdentifier!.upsert!({
          where: { itemId_type: { itemId: primaryId, type: idObj.type } },
          update: { value: idObj.value, canonicalUri: idObj.canonicalUri },
          create: { itemId: primaryId, ...idObj },
        }),
      ),
    );
  }

  if (identTx.itemIdentifier.deleteMany && uniqueDupIds.length > 0) {
    await identTx.itemIdentifier.deleteMany({
      where: { itemId: { in: uniqueDupIds } },
    });
  }
}
