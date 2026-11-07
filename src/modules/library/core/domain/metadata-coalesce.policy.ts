import { Prisma, TagType } from '@prisma/client';
import { isUuid } from './title.domain';
import { normalizeTags } from './tag.domain';
import { resolveSpaceId } from './specification.domain';

export * from './bibliographic-reconciler.domain';

export async function resolveOrCreateAutomaticTagsInClient(
  db: Prisma.TransactionClient,
  userId: string,
  rawTagList: ReadonlyArray<
    string | { tag?: string; name?: string; type?: number | string } | null | undefined
  >,
  defaultTagType: TagType = TagType.automatic,
  projectId?: string | null,
  options?: {
    allowManualAcademicTerms?: boolean;
    tagTypeMap?: Map<string, TagType>;
    existingItemTags?: ReadonlyArray<{
      tagId?: string;
      type?: TagType | string | number;
      name?: string;
      tag?: { id?: string; name?: string; type?: TagType | string | number };
    }>;
  },
): Promise<Array<{ id: string; type: TagType }>> {
  const normalizedTagNames = normalizeTags(rawTagList as never, {
    allowManualAcademicTerms: options?.allowManualAcademicTerms ?? false,
  }).slice(0, 500);
  if (normalizedTagNames.length === 0) return [];
  const effectiveProjectId =
    projectId &&
    projectId !== 'user' &&
    projectId !== 'me' &&
    projectId !== 'personal' &&
    isUuid(projectId)
      ? projectId
      : null;
  const spaceId = resolveSpaceId({ userId, projectId: effectiveProjectId });
  const scopeWhere: Prisma.LibraryTagWhereInput = { spaceId };
  const tagTypeMap = options?.tagTypeMap ?? new Map<string, TagType>();
  const existingItemTagTypeMap = new Map<string, TagType>();
  const preloadedTagMap = new Map<string, { id: string; name: string; type?: TagType }>();
  if (Array.isArray(options?.existingItemTags)) {
    for (const eit of options.existingItemTags) {
      if (!eit) continue;
      const rawName = (eit.tag?.name || eit.name || '').trim();
      const lowerName = rawName.toLowerCase();
      if (!lowerName) continue;
      const rawType = eit.type ?? eit.tag?.type;
      const resolvedExistingType =
        rawType === TagType.automatic || rawType === 'automatic' || rawType === 1
          ? TagType.automatic
          : rawType === TagType.manual || rawType === 'manual' || rawType === 0
            ? TagType.manual
            : undefined;
      if (resolvedExistingType) existingItemTagTypeMap.set(lowerName, resolvedExistingType);
      const existingTagId = eit.tag?.id || eit.tagId;
      if (existingTagId && !preloadedTagMap.has(lowerName)) {
        preloadedTagMap.set(lowerName, {
          id: existingTagId,
          name: rawName,
          type: resolvedExistingType,
        });
      }
    }
  }
  const unresolvedTagNames = normalizedTagNames.filter(
    (name) => !preloadedTagMap.has(name.trim().toLowerCase()),
  );
  const tagOrFilter = unresolvedTagNames.map((name) => ({
    name: { equals: name, mode: 'insensitive' as const },
  }));
  const preExistingTags =
    unresolvedTagNames.length === 0
      ? Array.from(preloadedTagMap.values())
      : (await db.libraryTag.findMany({
          where: { ...scopeWhere, OR: tagOrFilter },
          select: { id: true, name: true, normalizedName: true, type: true },
        })) || [];
  const existingLowerNames = new Set(
    preExistingTags
      .map((t: { id: string; name?: string; normalizedName?: string }) =>
        typeof t.normalizedName === 'string' && t.normalizedName
          ? t.normalizedName.trim().toLowerCase()
          : typeof t.name === 'string'
            ? t.name.trim().toLowerCase()
            : '',
      )
      .filter(Boolean),
  );
  const seenMissingLower = new Set<string>();
  const missingTagNames = normalizedTagNames.filter((name) => {
    const lower = name.trim().toLowerCase();
    if (existingLowerNames.has(lower) || seenMissingLower.has(lower)) return false;
    seenMissingLower.add(lower);
    return true;
  });
  if (missingTagNames.length > 0) {
    if (typeof db.libraryTag.createMany === 'function') {
      await db.libraryTag.createMany({
        data: missingTagNames.map((name) => {
          const lower = name.trim().toLowerCase();
          return {
            spaceId,
            createdById: userId,
            name,
            normalizedName: lower,
            type: tagTypeMap.get(lower) || existingItemTagTypeMap.get(lower) || defaultTagType,
          };
        }),
        skipDuplicates: true,
      });
    } else {
      for (const name of missingTagNames) {
        try {
          const lower = name.trim().toLowerCase();
          await db.libraryTag.create({
            data: {
              spaceId,
              createdById: userId,
              name,
              normalizedName: lower,
              type: tagTypeMap.get(lower) || existingItemTagTypeMap.get(lower) || defaultTagType,
            },
          });
        } catch {
          // Concurrent creation
        }
      }
    }
  }
  const allTagOrFilter = normalizedTagNames.map((name) => ({
    name: { equals: name, mode: 'insensitive' as const },
  }));
  const allMatchingTags =
    missingTagNames.length > 0
      ? (await db.libraryTag.findMany({
          where: { ...scopeWhere, OR: allTagOrFilter },
          select: { id: true, name: true, normalizedName: true, type: true },
        })) || preExistingTags
      : preExistingTags;
  const dedupedByLower = new Map<string, { id: string; type: TagType }>();
  for (const t of allMatchingTags as Array<{
    id: string;
    name?: string;
    normalizedName?: string;
    type?: TagType;
  }>) {
    const key =
      typeof t.normalizedName === 'string' && t.normalizedName
        ? t.normalizedName.trim().toLowerCase()
        : typeof t.name === 'string'
            ? t.name.trim().toLowerCase()
            : t.id;
    if (!dedupedByLower.has(key)) {
      dedupedByLower.set(key, {
        id: t.id,
        type:
          tagTypeMap.get(key) ||
          existingItemTagTypeMap.get(key) ||
          t.type ||
          defaultTagType ||
          TagType.manual,
      });
    }
  }
  const resolvedList = Array.from(dedupedByLower.values());
  const manualTagIds = resolvedList.filter((rt) => rt.type === TagType.manual).map((rt) => rt.id);
  if (manualTagIds.length > 0 && typeof db.libraryTag?.updateMany === 'function') {
    await db.libraryTag.updateMany({
      where: { id: { in: manualTagIds }, type: TagType.automatic },
      data: { type: TagType.manual },
    });
  }
  return resolvedList;
}
