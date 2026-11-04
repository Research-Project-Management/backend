import * as zlib from 'zlib';
import { Prisma, TagType } from '@prisma/client';
import { normalizeTags } from '../domain/tag.domain';
import { IUnitOfWork, TransactionHelpers } from '../ports';
import { promisify } from 'util';
import { BaseDomainException } from '../errors/domain.exception';
import { randomBytes } from 'crypto';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/config/library.config';
import { normalizeProjectScopeId } from '@/modules/library/core/domain/specification.domain';
import { IItemCacheInvalidator } from '@/modules/library/core/ports';

export interface ItemDenormalizedCountClient {
  attachment?: {
    count?: (args: { where: { itemId: string; deletedAt: null } }) => Promise<number>;
  };
  note?: {
    count?: (args: { where: { itemId: string; deletedAt: null } }) => Promise<number>;
  };
  item?: {
    updateMany?: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    update?: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
}

/**
 * Shared repository helper to recount and synchronize denormalized `attachmentCount`,
 * `hasFile`, and `noteCount` columns on `Item` within a Prisma client or transaction.
 */
export async function syncItemDenormalizedCountsInClient(
  client: ItemDenormalizedCountClient | null | undefined,
  itemId: string | null | undefined,
  options?: { attachments?: boolean; notes?: boolean; requireUuid?: boolean },
): Promise<void> {
  if (!itemId || !client?.item) return;
  if (options?.requireUuid && !isUuid(itemId)) return;

  const syncAttachments = options?.attachments ?? false;
  const syncNotes = options?.notes ?? false;
  if (!syncAttachments && !syncNotes) return;

  const data: Record<string, unknown> = {};

  if (syncAttachments && client.attachment) {
    const rawCount = client.attachment.count
      ? await client.attachment.count({ where: { itemId, deletedAt: null } })
      : 1;
    const activeCount = Math.max(0, rawCount);
    data.hasFile = activeCount > 0;
    data.attachmentCount = activeCount;
  }

  if (syncNotes && client.note?.count) {
    const activeNoteCount = await client.note.count({
      where: { itemId, deletedAt: null },
    });
    data.noteCount = Math.max(0, activeNoteCount);
  }

  if (Object.keys(data).length === 0) return;

  if (client.item.updateMany) {
    await client.item.updateMany({ where: { id: itemId }, data });
  } else if (client.item.update) {
    await client.item.update({ where: { id: itemId }, data });
  }
}

/**
 * Executes a Unit of Work transaction and guarantees that `afterCommit` runs once:
 * via `helpers.onAfterCommit` if supported by the transaction runner, or immediately
 * after `executeInTransaction` resolves when `onAfterCommit` is absent (e.g., in test mocks).
 */
export async function executeWithPostCommit<T>(
  uow: IUnitOfWork,
  work: (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => Promise<T>,
  afterCommit: (result: T) => Promise<void> | void,
): Promise<T> {
  let registered = false;
  let capturedResult!: T;
  const result = await uow.executeInTransaction(async (tx, helpers) => {
    const res = await work(tx, helpers);
    capturedResult = res;
    if (helpers?.onAfterCommit) {
      registered = true;
      helpers.onAfterCommit(() => afterCommit(res));
    }
    return res;
  });
  if (!registered) {
    await afterCommit(result ?? capturedResult);
  }
  return result;
}

/**
 * Automatically disambiguates citation keys against existing items in the project or user scope.
 * Follows BibTeX / BetterBibTeX convention: vaswani2017attention -> vaswani2017attentiona -> vaswani2017attentionb.
 */
export async function disambiguateCitationKey(
  client:
    | Prisma.TransactionClient
    | { item?: { findMany?: Prisma.TransactionClient['item']['findMany'] } }
    | null
    | undefined,
  baseKey: string | null | undefined,
  scope: { userId: string; projectId?: string | null },
  excludeItemId?: string,
): Promise<string | null> {
  if (!baseKey || !baseKey.trim()) return null;
  const cleanKey = baseKey.trim();
  if (typeof client?.item?.findMany !== 'function') return cleanKey;
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
  const existingKeys = new Set(
    (Array.isArray(rows) ? rows : [])
      .map((item: { citationKey?: string | null }) => item.citationKey?.toLowerCase())
      .filter((k: string | undefined): k is string => Boolean(k)),
  );
  if (!existingKeys.has(cleanKey.toLowerCase())) return cleanKey;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < alphabet.length; i++) {
    const candidate = `${cleanKey}${alphabet[i]}`;
    if (!existingKeys.has(candidate.toLowerCase())) return candidate;
  }
  let counter = 1;
  while (existingKeys.has(`${cleanKey}-${counter}`.toLowerCase())) counter++;
  return `${cleanKey}-${counter}`;
}

export async function resolveOrCreateAutomaticTagsInClient(
  client: Prisma.TransactionClient,
  userId: string,
  rawTagList: ReadonlyArray<string | { tag?: string; name?: string; type?: number | string } | null | undefined>,
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
    projectId && projectId !== 'user' && projectId !== 'me' && projectId !== 'personal' && isUuid(projectId)
      ? projectId
      : null;
  const scopeWhere: Prisma.TagWhereInput = effectiveProjectId
    ? { projectId: effectiveProjectId }
    : { userId, projectId: null };
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
        preloadedTagMap.set(lowerName, { id: existingTagId, name: rawName, type: resolvedExistingType });
      }
    }
  }
  const unresolvedTagNames = normalizedTagNames.filter((name) => !preloadedTagMap.has(name.trim().toLowerCase()));
  const tagOrFilter = unresolvedTagNames.map((name) => ({
    name: { equals: name, mode: 'insensitive' as const },
  }));
  const preExistingTags =
    unresolvedTagNames.length === 0
      ? Array.from(preloadedTagMap.values())
      : (await client.tag.findMany({
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
    if (typeof client.tag.createMany === 'function') {
      await client.tag.createMany({
        data: missingTagNames.map((name) => {
          const lower = name.trim().toLowerCase();
          return {
            userId,
            createdById: userId,
            name,
            normalizedName: lower,
            type: tagTypeMap.get(lower) || existingItemTagTypeMap.get(lower) || defaultTagType,
            projectId: effectiveProjectId,
          };
        }),
        skipDuplicates: true,
      });
    } else {
      for (const name of missingTagNames) {
        try {
          const lower = name.trim().toLowerCase();
          await client.tag.create({
            data: {
              userId,
              createdById: userId,
              name,
              normalizedName: lower,
              type: tagTypeMap.get(lower) || existingItemTagTypeMap.get(lower) || defaultTagType,
              projectId: effectiveProjectId,
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
      ? (await client.tag.findMany({
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
        type: tagTypeMap.get(key) || existingItemTagTypeMap.get(key) || t.type || defaultTagType || TagType.manual,
      });
    }
  }
  const resolvedList = Array.from(dedupedByLower.values());
  const manualTagIds = resolvedList.filter((rt) => rt.type === TagType.manual).map((rt) => rt.id);
  if (manualTagIds.length > 0 && typeof client.tag?.updateMany === 'function') {
    await client.tag.updateMany({
      where: { id: { in: manualTagIds }, type: TagType.automatic },
      data: { type: TagType.manual },
    });
  }
  return resolvedList;
}

export const gzipAsync = promisify(zlib.gzip);
export const gunzipAsync = promisify(zlib.gunzip);

export const MAX_SAFE_HTTP_PAYLOAD_BYTES = 100 * 1024 * 1024; // 100 MB upper limit
export const MAX_SAFE_TEXT_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MB default for HTML/XML/JSON

export class PayloadTooLargeException extends BaseDomainException {
  override readonly code = 'LIBRARY_PAYLOAD_TOO_LARGE';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = 'PayloadTooLargeException';
  }
}

export async function readSafeResponseBuffer(
  response: Response,
  maxBytes = MAX_SAFE_HTTP_PAYLOAD_BYTES,
): Promise<Buffer> {
  const contentLengthHeader = response.headers?.get?.('content-length');
  if (contentLengthHeader) {
    const declaredLength = parseInt(contentLengthHeader, 10);
    if (!isNaN(declaredLength) && declaredLength > maxBytes) {
      throw new PayloadTooLargeException(
        `Payload size (${(declaredLength / (1024 * 1024)).toFixed(1)} MB) exceeds safe OS limit of ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`,
      );
    }
  }

  const streamBody = response.body as ReadableStream<Uint8Array> | null;
  if (streamBody && typeof streamBody.getReader === 'function') {
    const reader = streamBody.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.length;
          if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new PayloadTooLargeException(
              `Stream exceeded safe OS payload limit of ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`,
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      if (typeof reader.releaseLock === 'function') {
        reader.releaseLock();
      }
    }

    return Buffer.concat(chunks, totalBytes);
  }

  const arrayBuf = await response.arrayBuffer();
  if (arrayBuf.byteLength > maxBytes) {
    throw new PayloadTooLargeException(
      `Response buffer (${(arrayBuf.byteLength / (1024 * 1024)).toFixed(1)} MB) exceeds safe OS limit of ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`,
    );
  }
  return Buffer.from(arrayBuf);
}

export async function readSafeResponseText(
  response: Response,
  maxBytes = MAX_SAFE_TEXT_PAYLOAD_BYTES,
): Promise<string> {
  const streamBody = response.body as ReadableStream<Uint8Array> | null;
  if (
    (streamBody && typeof streamBody.getReader === 'function') ||
    typeof response.arrayBuffer === 'function'
  ) {
    const buf = await readSafeResponseBuffer(response, maxBytes);
    return buf.toString('utf-8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
    throw new PayloadTooLargeException(
      `Text payload exceeds safe limit of ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`,
    );
  }
  return text;
}

let lastTime = 0;
let seq = 0;

/**
 * Generates an RFC 9562 compliant UUID v7 string using Node's native `crypto`.
 * Time-ordered 128-bit identifier with 48-bit millisecond precision and monotonic sequence.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);

  const now = Date.now();
  if (now > lastTime) {
    lastTime = now;
    seq = ((bytes[6] & 0x0f) << 8) | bytes[7];
  } else {
    seq = (seq + 1) & 0x0fff;
  }

  bytes[0] = Math.floor(now / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(now / 0x100000000) & 0xff;
  bytes[2] = Math.floor(now / 0x1000000) & 0xff;
  bytes[3] = Math.floor(now / 0x10000) & 0xff;
  bytes[4] = Math.floor(now / 0x100) & 0xff;
  bytes[5] = now & 0xff;

  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;

  bytes[8] = 0x80 | (bytes[8] & 0x3f);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(val?: string | null): boolean {
  return typeof val === 'string' && UUID_REGEX.test(val);
}

export interface IRawLibraryCache {
  del(key: string): Promise<unknown>;
  delPattern?(pattern: string): Promise<unknown>;
}

export interface StandardLibraryCacheInvalidationParams {
  userId?: string;
  projectId?: string | null;
  itemIds?: string[];
  additionalProjectIds?: Array<string | null | undefined>;
  extraKeys?: string[];
  skipScopeInvalidation?: boolean;
  onlyUserStateOverlay?: boolean;
  preserveContentCaches?: boolean;
}

export type CacheInvalidatorOrGateway =
  | IItemCacheInvalidator
  | {
      invalidateForWrite?: (params: {
        userId: string;
        projectId?: string | null;
        itemIds?: string[];
        additionalProjectIds?: Array<string | null | undefined>;
        skipScopeInvalidation?: boolean;
        onlyUserStateOverlay?: boolean;
        preserveContentCaches?: boolean;
      }) => Promise<void>;
    }
  | null
  | undefined;

/**
 * Evicts raw Redis keys and patterns for a set of item IDs and user/project scopes.
 */
export async function invalidateLibraryScopeCaches(
  rawCache: IRawLibraryCache | null | undefined,
  params: StandardLibraryCacheInvalidationParams,
): Promise<void> {
  if (!rawCache) return;
  const {
    userId,
    projectId,
    itemIds,
    additionalProjectIds,
    skipScopeInvalidation,
    onlyUserStateOverlay,
    preserveContentCaches,
  } = params;
  const uniqueIds = itemIds
    ? Array.from(new Set(itemIds.filter(Boolean).map(String)))
    : [];
  const hasDelPattern = typeof rawCache.delPattern === 'function';
  const tasks: Promise<unknown>[] = [];

  for (const id of uniqueIds) {
    if (onlyUserStateOverlay) {
      tasks.push(
        rawCache.del(LIBRARY_REDIS_KEYS.item(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
      );
      if (userId) {
        tasks.push(
          rawCache.del(LIBRARY_REDIS_KEYS.itemUserOverlay(id, userId)),
          rawCache.del(LIBRARY_REDIS_KEYS.counts(userId)),
          ...(projectId
            ? [rawCache.del(LIBRARY_REDIS_KEYS.counts(userId, projectId))]
            : []),
        );
      }
    } else if (preserveContentCaches) {
      tasks.push(
        rawCache.del(LIBRARY_REDIS_KEYS.item(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemAttachments(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemNotes(id)),
      );
      if (userId) {
        tasks.push(rawCache.del(LIBRARY_REDIS_KEYS.itemUserOverlay(id, userId)));
      }
    } else {
      tasks.push(
        rawCache.del(LIBRARY_REDIS_KEYS.item(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemFulltext(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemAttachments(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemNotes(id)),
      );
      if (userId) {
        tasks.push(rawCache.del(LIBRARY_REDIS_KEYS.itemUserOverlay(id, userId)));
      }
      if (hasDelPattern) {
        tasks.push(rawCache.delPattern!(LIBRARY_REDIS_KEYS.itemPattern(id)));
      }
    }
  }

  if (!skipScopeInvalidation) {
    if (userId) {
      const userSyncScope = `user:${userId}`;
      tasks.push(
        rawCache.del(LIBRARY_REDIS_KEYS.savedSearches(userId)),
        rawCache.del(LIBRARY_REDIS_KEYS.searchVersion(userId)),
        rawCache.del(LIBRARY_REDIS_KEYS.counts(userId)),
        rawCache.del(LIBRARY_REDIS_KEYS.tags(userId)),
        rawCache.del(LIBRARY_REDIS_KEYS.syncSequence(userSyncScope)),
        rawCache.del(LIBRARY_REDIS_KEYS.minRetainedSequence(userSyncScope)),
      );
      if (hasDelPattern) {
        tasks.push(
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.tagsPattern(userId)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.collectionsPattern(userId)),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.collectionsPattern(`u:${userId}`),
          ),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.countsPattern(userId)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.searchFacetsPattern(userId)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.searchItemsPattern(userId)),
        );
      }
    }

    const projectScopes = new Set<string>();
    const validBaseProject = normalizeProjectScopeId(projectId ?? undefined);
    if (validBaseProject) projectScopes.add(validBaseProject);
    if (additionalProjectIds) {
      for (const pid of additionalProjectIds) {
        const norm = normalizeProjectScopeId(pid ?? undefined);
        if (norm) projectScopes.add(norm);
      }
    }

    for (const validProjectId of projectScopes) {
      const projScope = `proj:${validProjectId}`;
      tasks.push(
        rawCache.del(LIBRARY_REDIS_KEYS.savedSearches(validProjectId)),
        rawCache.del(LIBRARY_REDIS_KEYS.searchVersion(validProjectId)),
        rawCache.del(LIBRARY_REDIS_KEYS.searchVersion(projScope)),
        rawCache.del(LIBRARY_REDIS_KEYS.counts(projScope)),
        ...(userId
          ? [rawCache.del(LIBRARY_REDIS_KEYS.counts(userId, validProjectId))]
          : []),
        rawCache.del(LIBRARY_REDIS_KEYS.tags(validProjectId)),
        rawCache.del(LIBRARY_REDIS_KEYS.tags(projScope)),
        rawCache.del(LIBRARY_REDIS_KEYS.syncSequence(projScope)),
        rawCache.del(LIBRARY_REDIS_KEYS.minRetainedSequence(projScope)),
      );
      if (hasDelPattern) {
        tasks.push(
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.itemsPattern(validProjectId)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.itemsPattern(projScope)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.tagsPattern(validProjectId)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.tagsPattern(projScope)),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.collectionsPattern(validProjectId),
          ),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.collectionsPattern(projScope)),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.countsPattern(validProjectId),
          ),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.searchFacetsPattern(validProjectId),
          ),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.searchItemsPattern(validProjectId),
          ),
        );
      }
    }
  }

  await Promise.all(tasks);
}

/**
 * Hollywood Principle delegation helper for Library write-path cache invalidation.
 */
export async function executeStandardLibraryCacheInvalidation(
  coordinatorOrGateway: CacheInvalidatorOrGateway,
  rawCache: IRawLibraryCache | null | undefined,
  params: StandardLibraryCacheInvalidationParams,
  onWarning?: (message: string) => void,
): Promise<void> {
  const { userId, projectId, itemIds, additionalProjectIds, extraKeys } =
    params;
  const uniqueIds = itemIds
    ? Array.from(new Set(itemIds.filter(Boolean).map(String)))
    : [];

  if (extraKeys && extraKeys.length > 0 && rawCache) {
    try {
      await Promise.all(extraKeys.map((k) => rawCache.del(k)));
    } catch (err: unknown) {
      if (onWarning) {
        onWarning(err instanceof Error ? err.message : String(err));
      }
    }
  }

  if (
    coordinatorOrGateway?.invalidateForWrite &&
    userId &&
    !params.skipScopeInvalidation &&
    !params.onlyUserStateOverlay &&
    !params.preserveContentCaches
  ) {
    try {
      await coordinatorOrGateway.invalidateForWrite({
        userId: String(userId),
        projectId: projectId ? String(projectId) : undefined,
        itemIds: uniqueIds.length > 0 ? uniqueIds : undefined,
        additionalProjectIds,
      });
      return;
    } catch (err: unknown) {
      if (onWarning) {
        onWarning(err instanceof Error ? err.message : String(err));
      }
      return;
    }
  }

  if (rawCache) {
    try {
      await invalidateLibraryScopeCaches(rawCache, {
        ...params,
        itemIds: uniqueIds,
      });
      return;
    } catch (err: unknown) {
      if (onWarning) {
        onWarning(err instanceof Error ? err.message : String(err));
      }
      return;
    }
  }

  if (coordinatorOrGateway?.invalidateForWrite && userId) {
    try {
      await coordinatorOrGateway.invalidateForWrite({
        userId: String(userId),
        projectId: projectId ? String(projectId) : undefined,
        itemIds: uniqueIds.length > 0 ? uniqueIds : undefined,
        additionalProjectIds,
        skipScopeInvalidation: params.skipScopeInvalidation,
        onlyUserStateOverlay: params.onlyUserStateOverlay,
        preserveContentCaches: params.preserveContentCaches,
      });
    } catch (err: unknown) {
      if (onWarning) {
        onWarning(err instanceof Error ? err.message : String(err));
      }
    }
  }
}
