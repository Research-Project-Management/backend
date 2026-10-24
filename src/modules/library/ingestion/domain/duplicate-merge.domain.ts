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
  'retraction',
  'retractionDate',
  'retractionNature',
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

export async function consolidateUserPublications(
  tx: Prisma.TransactionClient,
  primaryId: string,
  uniqueDupIds: string[],
): Promise<void> {
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
