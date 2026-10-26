import { Prisma } from '@prisma/client';
import {
  ALLOWED_MERGE_METADATA_FIELDS,
  PrismaMergeAuditTrail,
} from '@/modules/library/ingestion/types/curation.types';
import {
  asMetaObject,
  getEffectiveItemField,
} from '@/modules/library/ingestion/services/duplicate-detector.service';
import { normalizeDoi } from '@/modules/library/core';

export interface ContributorShape {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
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

export const TOP_LEVEL_ITEM_COLUMNS = new Set([
  'title',
  'itemType',
  'year',
  'citationKey',
  'doi',
  'publicationTitle',
  'abstract',
  'url',
  'firstAuthor',
]);

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

  const relationIdsToDelete: string[] = [];

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
      await tx.itemRelation.update({
        where: { id: rel.id },
        data: { sourceItemId: newSourceId, targetItemId: newTargetId },
      });
      primaryExistingPairs.add(candidateKey);
    }
  }

  if (relationIdsToDelete.length > 0) {
    if (tx.itemRelation.deleteMany) {
      await tx.itemRelation.deleteMany({
        where: { id: { in: relationIdsToDelete } },
      });
    } else {
      for (const relId of relationIdsToDelete) {
        await tx.itemRelation.delete({ where: { id: relId } });
      }
    }
  }
}

export async function consolidateUserPublications(
  tx: Prisma.TransactionClient,
  primaryId: string,
  uniqueDupIds: string[],
): Promise<void> {
  const dupPublications = await tx.userPublication.findMany({
    where: { itemId: { in: uniqueDupIds } },
  });
  if (dupPublications.length === 0) return;

  const primaryPubByUser = new Map<string, (typeof dupPublications)[number]>();

  for (const pub of dupPublications) {
    let existingPrimaryPub = primaryPubByUser.get(pub.userId) ?? null;
    if (!existingPrimaryPub && tx.userPublication.findUnique) {
      existingPrimaryPub = await tx.userPublication.findUnique({
        where: {
          userId_itemId: { userId: pub.userId, itemId: primaryId },
        },
      });
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
}

export async function syncMergedContributors(
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
    await tx.contributor.deleteMany({ where: { itemId: primaryId } });
    await tx.contributor.createMany({
      data: chosenContributors.map(mapContributorInput),
    });
    return;
  }

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
