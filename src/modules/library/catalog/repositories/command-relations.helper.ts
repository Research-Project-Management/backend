import { NotFoundException } from '@nestjs/common';
import { Prisma, RelationType, TagType } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import {
  normalizeProjectScopeId,
  normalizeAcademicTags,
} from '@/modules/library/core';
import {
  CreateItemData,
  UpdateItemData,
  ItemDetail,
} from '@/modules/library/core/types/bibliographic.types';
import { TagInput } from '@/modules/library/catalog/types/catalog.types';
import {
  buildMyPublicationMetadata,
  calculateIdentifierChanges,
  normalizeItemIdentifiers,
} from '@/modules/library/catalog/domain/identifier-change.helper';
import {
  ResolvedTag,
  buildTagTypeMap,
} from '@/modules/library/catalog/domain/creator-tag-payload.builder';
import {
  buildCommandCreateInput,
  extractUniqueCreateCollectionIds,
  resolveCreateDefaultTagType,
} from '@/modules/library/catalog/domain/command-payload.builder';

export { buildTagTypeMap };
export type { ResolvedTag };

export async function resolveOrCreateTags(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  rawTagList: (TagInput | null | undefined)[],
  defaultTagType: TagType = TagType.manual,
  projectId?: string | null,
): Promise<ResolvedTag[]> {
  const normalizedTagNames = normalizeAcademicTags(rawTagList).slice(0, 500);
  if (normalizedTagNames.length === 0) return [];
  const effectiveProjectId =
    projectId &&
    projectId !== 'user' &&
    projectId !== 'me' &&
    projectId !== 'personal' &&
    isUuid(projectId)
      ? projectId
      : null;
  const scopeWhere: Prisma.TagWhereInput = effectiveProjectId
    ? { projectId: effectiveProjectId }
    : { userId, projectId: null };
  const tagTypeMap = buildTagTypeMap(rawTagList);
  const tagOrFilter = normalizedTagNames.map((name) => ({
    name: { equals: name, mode: 'insensitive' as const },
  }));
  const preExistingTags =
    (await client.tag.findMany({
      where: { ...scopeWhere, OR: tagOrFilter },
      select: { id: true, name: true, type: true },
    })) || [];
  const existingLowerNames = new Set(
    preExistingTags
      .map((t: { id: string; name?: string }) =>
        typeof t.name === 'string' ? t.name.toLowerCase() : '',
      )
      .filter(Boolean),
  );
  const seenMissingLower = new Set<string>();
  const missingTagNames = normalizedTagNames.filter((name) => {
    const lower = name.toLowerCase();
    if (existingLowerNames.has(lower) || seenMissingLower.has(lower)) {
      return false;
    }
    seenMissingLower.add(lower);
    return true;
  });
  if (missingTagNames.length > 0) {
    if (typeof client.tag.createMany === 'function') {
      await client.tag.createMany({
        data: missingTagNames.map((name) => ({
          userId,
          createdById: userId,
          name,
          type: tagTypeMap.get(name.toLowerCase()) || defaultTagType,
          projectId: effectiveProjectId,
        })),
        skipDuplicates: true,
      });
    } else {
      for (const name of missingTagNames) {
        try {
          await client.tag.create({
            data: {
              userId,
              createdById: userId,
              name,
              type: tagTypeMap.get(name.toLowerCase()) || defaultTagType,
              projectId: effectiveProjectId,
            },
          });
        } catch {
          // Tag was created concurrently or already exists
        }
      }
    }
  }
  const allMatchingTags =
    missingTagNames.length > 0
      ? (await client.tag.findMany({
          where: { ...scopeWhere, OR: tagOrFilter },
          select: { id: true, name: true, type: true },
        })) || preExistingTags
      : preExistingTags;
  const dedupedByLower = new Map<string, ResolvedTag>();
  for (const t of allMatchingTags as Array<{
    id: string;
    name?: string;
    type?: TagType;
  }>) {
    const key = typeof t.name === 'string' ? t.name.toLowerCase() : t.id;
    if (!dedupedByLower.has(key)) {
      dedupedByLower.set(key, {
        id: t.id,
        type: tagTypeMap.get(key) || t.type || defaultTagType,
      });
    }
  }
  return Array.from(dedupedByLower.values());
}

export async function syncTagsForCatalogItem(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  itemId: string,
  rawTags: (TagInput | null | undefined)[],
  defaultTagType: TagType = TagType.manual,
  projectId?: string | null,
): Promise<void> {
  const normalizedTagsList = normalizeAcademicTags(rawTags);
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
  );
  if (resolvedTags.length === 0) {
    await client.itemTag.deleteMany({ where: { itemId } });
    return;
  }
  await client.itemTag.deleteMany({
    where: { itemId, tagId: { notIn: resolvedTags.map((t) => t.id) } },
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
  const metadataObj = buildMyPublicationMetadata(
    existing.metadata,
    isMyPublication,
    isSharedProjectItem ? { ...options, stripSharedFlag: true } : options,
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

/**
 * Automatically disambiguates citation keys against existing items in the project or user scope.
 * Follows BibTeX / BetterBibTeX convention: vaswani2017attention -> vaswani2017attentiona -> vaswani2017attentionb.
 */
export async function disambiguateCitationKey(
  client:
    | Prisma.TransactionClient
    | PrismaService
    | { item?: { findMany?: Prisma.TransactionClient['item']['findMany'] } }
    | null
    | undefined,
  baseKey: string | null | undefined,
  scope: { userId: string; projectId?: string | null },
  excludeItemId?: string,
): Promise<string | null> {
  if (!baseKey || !baseKey.trim()) return null;
  const cleanKey = baseKey.trim();

  if (typeof client?.item?.findMany !== 'function') {
    return cleanKey;
  }

  const scopeWhere: Prisma.ItemWhereInput =
    scope.projectId && isUuid(scope.projectId)
      ? { projectId: scope.projectId }
      : { userId: scope.userId, projectId: null };

  const rows = await client.item.findMany({
    where: {
      ...scopeWhere,
      deletedAt: null,
      ...(excludeItemId ? { id: { not: excludeItemId } } : {}),
      citationKey: { startsWith: cleanKey, mode: 'insensitive' },
    },
    select: { citationKey: true },
    take: 500,
  });
  const existing = Array.isArray(rows) ? rows : [];

  const existingKeys = new Set(
    existing
      .map((item: { citationKey?: string | null }) =>
        item.citationKey?.toLowerCase(),
      )
      .filter((k: string | undefined): k is string => Boolean(k)),
  );

  if (!existingKeys.has(cleanKey.toLowerCase())) {
    return cleanKey;
  }

  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < alphabet.length; i++) {
    const candidate = `${cleanKey}${alphabet[i]}`;
    if (!existingKeys.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  let counter = 1;
  while (existingKeys.has(`${cleanKey}-${counter}`.toLowerCase())) {
    counter++;
  }
  return `${cleanKey}-${counter}`;
}

export { disambiguateCitationKey as disambiguate };

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
  const resolvedTags = await resolveOrCreateTags(client, userId, rawTagList, defaultTagType, effectiveProjectId);
  const rawUniqueCollectionIds = extractUniqueCreateCollectionIds(data);
  let validCollectionIds: ReadonlySet<string> | undefined;
  if (rawUniqueCollectionIds.length > 0 && client.collection) {
    const validCollections = await client.collection.findMany({
      where: effectiveProjectId
        ? { id: { in: rawUniqueCollectionIds }, projectId: effectiveProjectId, deletedAt: null }
        : { id: { in: rawUniqueCollectionIds }, userId, projectId: null, deletedAt: null },
      select: { id: true },
    });
    if (Array.isArray(validCollections)) {
      validCollectionIds = new Set(validCollections.map((c) => c.id));
    }
  }
  const built = buildCommandCreateInput(userId, data, { resolvedTags, validCollectionIds }, projectId);
  if (built.rawCitationKey) {
    built.createData.citationKey = await disambiguateCitationKey(client, built.rawCitationKey, {
      userId,
      projectId: effectiveProjectId,
    });
  }
  return built;
}
