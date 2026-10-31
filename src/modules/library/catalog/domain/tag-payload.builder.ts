import { Prisma, TagType } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { normalizeAcademicTags, cleanSingleTag } from '@/modules/library/core';
import { TagInput } from '@/modules/library/catalog/types/tags.types';

export interface ResolvedTag {
  id: string;
  type: TagType;
}

export function buildTagTypeMap(
  rawTagList: (TagInput | null | undefined)[],
): Map<string, TagType> {
  const tagTypeMap = new Map<string, TagType>();
  if (!Array.isArray(rawTagList)) return tagTypeMap;
  for (const rt of rawTagList) {
    if (typeof rt === 'object' && rt !== null) {
      const tagName = (rt.name || rt.tag || '').trim();
      if (!tagName) continue;
      const typeVal =
        'type' in rt ? (rt as { type?: unknown }).type : undefined;
      let resolvedType: TagType | undefined;
      if (
        typeVal === 1 ||
        typeVal === 'automatic' ||
        typeVal === TagType.automatic
      ) {
        resolvedType = TagType.automatic;
      } else if (
        typeVal === 0 ||
        typeVal === 'manual' ||
        typeVal === TagType.manual
      ) {
        resolvedType = TagType.manual;
      }
      if (resolvedType) {
        tagTypeMap.set(tagName.toLowerCase(), resolvedType);
        const normalized = cleanSingleTag(tagName);
        if (normalized) tagTypeMap.set(normalized.toLowerCase(), resolvedType);
      }
    }
  }
  return tagTypeMap;
}

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
