import { NotFoundException } from '@nestjs/common';
import { Prisma, RelationType, TagType } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { normalizeProjectScopeId, disambiguateCitationKey, normalizeTags, resolveOrCreateAutomaticTagsInClient } from '@/modules/library/core';
import { CreateItemData, UpdateItemData, ItemDetail } from '@/modules/library/core/types/bibliographic.types';
import { TagInput } from '@/modules/library/catalog/types/catalog.types';
import {
  buildMyPublicationMetadata, calculateIdentifierChanges, normalizeItemIdentifiers,
} from '@/modules/library/catalog/domain/identifier-change.domain';
import { ResolvedTag, buildTagTypeMap } from '@/modules/library/catalog/domain/creator-tag.mapper';
import {
  buildCommandCreateInput, extractUniqueCreateCollectionIds, resolveCreateDefaultTagType,
} from '@/modules/library/catalog/domain/item-command.mapper';

export { buildTagTypeMap };
export type { ResolvedTag };

export async function resolveOrCreateTags(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  rawTagList: (TagInput | null | undefined)[],
  defaultTagType: TagType = TagType.manual,
  projectId?: string | null,
  existingItemTags?: ReadonlyArray<{
    tagId?: string;
    type?: TagType | string | number;
    name?: string;
    tag?: { id?: string; name?: string; type?: TagType | string | number };
  }>,
): Promise<ResolvedTag[]> {
  return resolveOrCreateAutomaticTagsInClient(
    client,
    userId,
    rawTagList,
    defaultTagType,
    projectId,
    {
      allowManualAcademicTerms: defaultTagType !== TagType.automatic,
      tagTypeMap: buildTagTypeMap(rawTagList),
      existingItemTags,
    },
  );
}

export async function syncTagsForCatalogItem(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  itemId: string,
  rawTags: (TagInput | null | undefined)[],
  defaultTagType: TagType = TagType.manual,
  projectId?: string | null,
  existingItemTags?: ReadonlyArray<{
    tagId?: string;
    type?: TagType | string | number;
    name?: string;
    tag?: { id?: string; name?: string; type?: TagType | string | number };
  }>,
): Promise<void> {
  const normalizedTagsList = normalizeTags(rawTags, {
    allowManualAcademicTerms: defaultTagType !== TagType.automatic,
  });
  if (normalizedTagsList.length === 0) {
    await client.itemTag.deleteMany({ where: { itemId } });
    return;
  }
  const resolvedTags = await resolveOrCreateTags(
    client,
    userId,
    rawTags,
    defaultTagType,
    projectId,
    existingItemTags,
  );
  if (resolvedTags.length === 0) {
    await client.itemTag.deleteMany({ where: { itemId } });
    return;
  }
  const existingTypeByTagId = new Map<string, TagType>();
  if (Array.isArray(existingItemTags)) {
    for (const eit of existingItemTags) {
      const tid = eit?.tagId ?? eit?.tag?.id;
      const rawType = eit?.type ?? eit?.tag?.type;
      if (tid) {
        existingTypeByTagId.set(
          tid,
          rawType === 'automatic' || rawType === 1 || rawType === TagType.automatic
            ? TagType.automatic
            : TagType.manual,
        );
      }
    }
  }
  const resolvedIds = resolvedTags.map((t) => t.id);
  const changedTypeTagIds = resolvedTags
    .filter((t) => {
      const prevType = existingTypeByTagId.get(t.id);
      return prevType !== undefined && prevType !== t.type;
    })
    .map((t) => t.id);

  await client.itemTag.deleteMany({
    where:
      changedTypeTagIds.length > 0
        ? {
            itemId,
            OR: [
              { tagId: { notIn: resolvedIds } },
              { tagId: { in: changedTypeTagIds } },
            ],
          }
        : { itemId, tagId: { notIn: resolvedIds } },
  });
  await client.itemTag.createMany({
    data: resolvedTags.map((t) => ({ tagId: t.id, itemId, type: t.type })),
    skipDuplicates: true,
  });
}

export async function syncCreatedIdentifiers(
  client: {
    itemIdentifier?: {
      upsert?: (...args: never[]) => Promise<unknown>;
      createMany?: (...args: never[]) => Promise<unknown>;
    };
  },
  itemId: string,
  identifiers: ReadonlyArray<{
    type: string;
    value: string;
    canonicalUri?: string | null;
  }>,
): Promise<void> {
  if (!client.itemIdentifier || identifiers.length === 0) return;
  const validIdentifiers = identifiers.filter((ident) => Boolean(ident.value));
  const upsertFn = client.itemIdentifier.upsert as
    | ((args: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  if (!upsertFn) return;
  await Promise.all(
    validIdentifiers.map((ident) =>
      upsertFn({
        where: { itemId_type: { itemId, type: ident.type } },
        create: {
          itemId,
          type: ident.type,
          value: ident.value,
          canonicalUri: ident.canonicalUri || null,
        },
        update: {
          value: ident.value,
          canonicalUri: ident.canonicalUri || null,
        },
      }),
    ),
  );
}

export async function syncUpdatedIdentifiers(
  client: {
    itemIdentifier?: {
      deleteMany?: (...args: never[]) => Promise<unknown>;
      upsert?: (...args: never[]) => Promise<unknown>;
    };
  },
  itemId: string,
  cleanIds: Partial<
    Record<
      keyof ReturnType<typeof normalizeItemIdentifiers>,
      string | null | undefined
    >
  >,
  existing: ItemDetail | Record<string, unknown>,
  explicitIdentifiers?: ReadonlyArray<{
    type: string;
    value: string | null;
    canonicalUri?: string | null;
  }> | null,
): Promise<void> {
  if (!client.itemIdentifier) return;
  const deleteManyFn = client.itemIdentifier.deleteMany as
    | ((args: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  const upsertFn = client.itemIdentifier.upsert as
    | ((args: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  const changes = calculateIdentifierChanges(
    cleanIds,
    existing,
    explicitIdentifiers,
  );
  await Promise.all(
    changes.map((change) => {
      if (!change.value) {
        return deleteManyFn?.({ where: { itemId, type: change.type } });
      }
      return upsertFn?.({
        where: { itemId_type: { itemId, type: change.type } },
        create: {
          itemId,
          type: change.type,
          value: change.value,
          canonicalUri: change.canonicalUri || null,
        },
        update: {
          value: change.value,
          canonicalUri: change.canonicalUri || null,
        },
      });
    }),
  );
}

export async function sanitizeUpdateCollectionIds(params: {
  client: Prisma.TransactionClient | PrismaService;
  userId: string;
  validProjectId?: string;
  existingProjectId?: string | null;
  data: UpdateItemData;
}): Promise<UpdateItemData> {
  const { client, userId, validProjectId, existingProjectId, data } = params;
  const rawCollections = (data as { collections?: string[] | null })
    .collections;
  if (
    data.collectionIds === undefined &&
    rawCollections === undefined &&
    data.collectionId === undefined
  ) {
    return data;
  }

  const candidateColIds = Array.from(
    new Set(
      [
        ...(Array.isArray(data.collectionIds) ? data.collectionIds : []),
        ...(Array.isArray(rawCollections) ? rawCollections : []),
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
    ...(data.collectionIds !== undefined || rawCollections !== undefined
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
): Promise<{ id: string } | undefined> {
  const targetItemId = relation.targetItemId;
  if (
    !targetItemId ||
    !isUuid(itemId) ||
    !isUuid(targetItemId) ||
    itemId === targetItemId
  ) {
    return undefined;
  }
  const [source, target] = await Promise.all([
    client.item.findUnique({
      where: { id: itemId },
      select: { userId: true, projectId: true, deletedAt: true },
    }),
    client.item.findUnique({
      where: { id: targetItemId },
      select: { userId: true, projectId: true, deletedAt: true },
    }),
  ]);
  if (!source || source.deletedAt || !target || target.deletedAt) {
    return undefined;
  }
  // Enforce strict scope boundary: target item must belong to the same project or personal library
  const sameScope = source.projectId
    ? target.projectId === source.projectId
    : !target.projectId && target.userId === source.userId;
  if (!sameScope) return undefined;
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
  return client.itemRelation.upsert({
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
  relationType?: RelationType,
): Promise<void> {
  if (!isUuid(itemId) || !isUuid(targetItemId)) return;
  await client.itemRelation.deleteMany({
    where: {
      ...(relationType ? { relationType } : {}),
      OR: [
        { sourceItemId: itemId, targetItemId },
        { sourceItemId: targetItemId, targetItemId: itemId },
      ],
    },
  });
}

const RELATION_PEER_SELECT = {
  id: true,
  title: true,
  itemType: true,
  year: true,
} as const;

export function buildCommandMutationInclude(
  userId: string,
  options?: { includeAttachmentRevisions?: boolean; orderNotes?: boolean },
) {
  return {
    collectionItems: { include: { collection: true } },
    itemTags: { include: { tag: true } },
    contributors: { orderBy: { orderIndex: 'asc' as const } },
    attachments: options?.includeAttachmentRevisions
      ? { where: { deletedAt: null }, include: { revisions: true } }
      : { where: { deletedAt: null } },
    notesList: options?.orderNotes
      ? { where: { deletedAt: null }, orderBy: { createdAt: 'desc' as const } }
      : { where: { deletedAt: null } },
    states: userId ? { where: { userId }, take: 1 } : false,
    identifiers: true,
    publications: { where: { userId } },
    outgoingRel: { include: { targetItem: { select: RELATION_PEER_SELECT } } },
    incomingRel: { include: { sourceItem: { select: RELATION_PEER_SELECT } } },
  } satisfies Prisma.ItemInclude;
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
    stripSharedPublicationFlag?: boolean;
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
  const isSharedProjectItem = Boolean(
    validProjectId ||
    (existing as { projectId?: string | null }).projectId ||
    options?.stripSharedPublicationFlag,
  );
  if (isSharedProjectItem) {
    const existingMetaObj =
      typeof existing.metadata === 'object' &&
      existing.metadata !== null &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    const hasStaleSharedPubKeys = [
      'isMyPublication',
      'myPublicationDetails',
      'publicationConfirmedAt',
      'openAccessLicense',
      'isPublicPublication',
      'publicationContributorId',
      'includeAttachmentsInMyPublications',
      'includeNotesInMyPublications',
      'authorshipConfirmed',
    ].some((k) => k in existingMetaObj);
    if (!hasStaleSharedPubKeys && typeof client.item?.findUnique === 'function') {
      const reloaded = await client.item.findUnique({
        where: { id },
        include: buildCommandMutationInclude(userId),
      });
      if (reloaded) return reloaded;
    }
    const strippedMeta = buildMyPublicationMetadata(
      existing.metadata,
      false,
      { ...options, stripSharedFlag: true },
    );
    return client.item.update({
      where: { id },
      data: {
        metadata: strippedMeta as Prisma.InputJsonValue,
      },
      include: buildCommandMutationInclude(userId),
    });
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
    include: buildCommandMutationInclude(userId),
  });
}

export { disambiguateCitationKey, disambiguateCitationKey as disambiguate };

export async function resolveCreateItemRelations(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  data: CreateItemData,
  projectId?: string,
) {
  const effectiveProjectId =
    (projectId && projectId !== 'user' && isUuid(projectId) ? projectId : undefined) ||
    (data.projectId && isUuid(data.projectId) ? data.projectId : null);
  const rawTagList = [...(data.tags || []), ...(data.keywords || []), ...(data.labels || [])];
  const defaultTagType = resolveCreateDefaultTagType(data);
  const rawUniqueCollectionIds = extractUniqueCreateCollectionIds(data);
  const [resolvedTags, validCollections] = await Promise.all([
    resolveOrCreateTags(client, userId, rawTagList, defaultTagType, effectiveProjectId),
    rawUniqueCollectionIds.length > 0 && client.collection
      ? client.collection.findMany({
          where: effectiveProjectId
            ? { id: { in: rawUniqueCollectionIds }, projectId: effectiveProjectId, deletedAt: null }
            : { id: { in: rawUniqueCollectionIds }, userId, projectId: null, deletedAt: null },
          select: { id: true },
        })
      : Promise.resolve(undefined),
  ]);
  const validCollectionIds = Array.isArray(validCollections)
    ? new Set(validCollections.map((c) => c.id))
    : undefined;
  const built = buildCommandCreateInput(userId, data, { resolvedTags, validCollectionIds }, projectId);
  if (built.rawCitationKey) {
    built.createData.citationKey = await disambiguateCitationKey(client, built.rawCitationKey, {
      userId,
      projectId: effectiveProjectId,
    });
  }
  return built;
}
