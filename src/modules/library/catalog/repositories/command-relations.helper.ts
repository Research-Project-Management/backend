import { NotFoundException } from '@nestjs/common';
import { Prisma, RelationType } from '@prisma/client';
import { PrismaService } from '@/core';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { UpdateItemData } from '@/modules/library/core/types/bibliographic.types';
import {
  isUuid,
  buildMyPublicationMetadata,
} from '@/modules/library/catalog/domain/command-payload.builder';

export async function sanitizeUpdateCollectionIds(params: {
  client: Prisma.TransactionClient | PrismaService;
  userId: string;
  validProjectId?: string;
  existingProjectId?: string | null;
  data: UpdateItemData;
}): Promise<UpdateItemData> {
  const { client, userId, validProjectId, existingProjectId, data } = params;
  if (data.collectionIds === undefined && data.collectionId === undefined) {
    return data;
  }

  const candidateColIds = Array.from(
    new Set(
      [
        ...(Array.isArray(data.collectionIds) ? data.collectionIds : []),
        ...(data.collectionId && typeof data.collectionId === 'string'
          ? [data.collectionId.trim()]
          : []),
      ].filter(
        (cid): cid is string =>
          typeof cid === 'string' && cid.trim().length > 0,
      ),
    ),
  );
  if (candidateColIds.length === 0 || !client.collection) {
    return data;
  }

  const targetProjectId = validProjectId ?? existingProjectId;
  const validCols = await client.collection.findMany({
    where: targetProjectId
      ? {
          id: { in: candidateColIds },
          projectId: targetProjectId,
          deletedAt: null,
        }
      : {
          id: { in: candidateColIds },
          userId,
          projectId: null,
          deletedAt: null,
        },
    select: { id: true },
  });
  if (!Array.isArray(validCols)) {
    return data;
  }

  const validColSet = new Set(validCols.map((c) => c.id));
  return {
    ...data,
    ...(data.collectionIds !== undefined
      ? {
          collectionIds: candidateColIds.filter((cid) => validColSet.has(cid)),
        }
      : {}),
    ...(data.collectionId !== undefined
      ? {
          collectionId:
            data.collectionId && validColSet.has(data.collectionId.trim())
              ? data.collectionId.trim()
              : null,
        }
      : {}),
  };
}

export async function putItemRelationInClient(
  client: Prisma.TransactionClient | PrismaService,
  itemId: string,
  relation: {
    targetItemId?: string;
    relationType?: string;
    description?: string;
  },
): Promise<void> {
  const targetItemId = relation.targetItemId;
  if (
    !targetItemId ||
    !isUuid(itemId) ||
    !isUuid(targetItemId) ||
    itemId === targetItemId
  ) {
    return;
  }
  const source = await client.item.findUnique({
    where: { id: itemId },
    select: { userId: true },
  });
  if (!source) return;
  const rawType = String(relation.relationType || '')
    .trim()
    .toLowerCase();
  const validRelationTypes = new Set<string>([
    'cites',
    'cited_by',
    'replicates',
    'extends',
    'is_preprint_of',
    'is_published_version_of',
    'is_translation_of',
    'supplements',
    'related',
    'rebuts',
    'uses_dataset',
    'survey_of',
  ]);
  const relationType: RelationType = validRelationTypes.has(rawType)
    ? (rawType as RelationType)
    : RelationType.related;
  const description = relation.description || '';
  await client.itemRelation.upsert({
    where: {
      sourceItemId_targetItemId_relationType: {
        sourceItemId: itemId,
        targetItemId,
        relationType,
      },
    },
    create: { sourceItemId: itemId, targetItemId, relationType, description },
    update: { description },
  });
}

export async function removeItemRelationInClient(
  client: Prisma.TransactionClient | PrismaService,
  itemId: string,
  targetItemId: string,
): Promise<void> {
  if (!isUuid(itemId) || !isUuid(targetItemId)) return;
  await client.itemRelation.deleteMany({
    where: {
      OR: [
        { sourceItemId: itemId, targetItemId },
        { sourceItemId: targetItemId, targetItemId: itemId },
      ],
    },
  });
}

export async function setMyPublicationInClient(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  id: string,
  isMyPublication: boolean,
  options?: {
    contributorId?: string | null;
    isPublic?: boolean;
    openAccessLicense?: string | null;
    includeAttachments?: boolean;
    includeNotes?: boolean;
    authorshipConfirmed?: boolean;
    projectId?: string;
  },
) {
  if (!isUuid(id) || !isUuid(userId)) {
    throw new NotFoundException(`CatalogItem ${id} not found`);
  }
  const validProjectId = normalizeProjectScopeId(options?.projectId);
  const scopeWhere = validProjectId
    ? { projectId: validProjectId }
    : { userId, projectId: null };
  const existing = await client.item.findFirst({
    where: { id, ...scopeWhere, deletedAt: null },
  });
  if (!existing) throw new NotFoundException(`CatalogItem ${id} not found`);
  if (isMyPublication) {
    const updatePayload = {
      ...(options?.contributorId !== undefined && {
        contributorId: options.contributorId,
      }),
      ...(options?.isPublic !== undefined && { isPublic: options.isPublic }),
      ...(options?.openAccessLicense !== undefined && {
        openAccessLicense: options.openAccessLicense,
      }),
    };
    await client.userPublication.upsert({
      where: { userId_itemId: { userId, itemId: id } },
      create: { userId, itemId: id, ...updatePayload },
      update: updatePayload,
    });
  } else {
    await client.userPublication.deleteMany({ where: { userId, itemId: id } });
  }
  const metadataObj = buildMyPublicationMetadata(
    existing.metadata,
    isMyPublication,
    options,
  );
  return client.item.update({
    where: { id },
    data: {
      metadata: metadataObj as Prisma.InputJsonValue,
      version: { increment: 1 },
    },
    include: {
      collectionItems: { include: { collection: true } },
      itemTags: { include: { tag: true } },
      contributors: { orderBy: { orderIndex: 'asc' } },
      attachments: true,
    },
  });
}
