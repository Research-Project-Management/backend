import { randomBytes } from 'crypto';
import { promisify } from 'util';
import * as zlib from 'zlib';
import { LIBRARY_REDIS_KEYS } from '../constants/redis-keys.constants';
import { normalizeProjectScopeId } from '../domain/specification.domain';
import { BaseDomainException } from '../errors/domain.exception';
import { IItemCacheInvalidator } from '../ports';

// ============================================================================
// 1. RFC 9562 UUID v7 Generator
// ============================================================================

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

// ============================================================================
// 2. Safe Stream Buffer Reader & Payload Size Guards
// ============================================================================

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

// ============================================================================
// 3. Shared Library Redis Cache Invalidation
// ============================================================================

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
}

export type CacheInvalidatorOrGateway =
  | IItemCacheInvalidator
  | {
      invalidateForWrite?: (params: {
        userId: string;
        projectId?: string | null;
        itemIds?: string[];
        additionalProjectIds?: Array<string | null | undefined>;
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
  } = params;
  const uniqueIds = itemIds
    ? Array.from(new Set(itemIds.filter(Boolean).map(String)))
    : [];
  const hasDelPattern = typeof rawCache.delPattern === 'function';
  const tasks: Promise<unknown>[] = [];

  for (const id of uniqueIds) {
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

  if (!skipScopeInvalidation) {
    if (userId) {
      tasks.push(
        rawCache.del(LIBRARY_REDIS_KEYS.savedSearches(userId)),
        rawCache.del(LIBRARY_REDIS_KEYS.searchVersion(userId)),
        rawCache.del(LIBRARY_REDIS_KEYS.counts(userId)),
        rawCache.del(LIBRARY_REDIS_KEYS.tags(userId)),
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
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.countsPattern(`user:${userId}`),
          ),
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
        rawCache.del(LIBRARY_REDIS_KEYS.tags(validProjectId)),
        rawCache.del(LIBRARY_REDIS_KEYS.tags(projScope)),
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
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.countsPattern(projScope)),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.searchFacetsPattern(validProjectId),
          ),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.searchFacetsPattern(projScope),
          ),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.searchItemsPattern(validProjectId),
          ),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.searchItemsPattern(projScope),
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

  if (coordinatorOrGateway?.invalidateForWrite && userId) {
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

  try {
    await invalidateLibraryScopeCaches(rawCache, {
      ...params,
      itemIds: uniqueIds,
    });
  } catch (err: unknown) {
    if (onWarning) {
      onWarning(err instanceof Error ? err.message : String(err));
    }
  }
}
