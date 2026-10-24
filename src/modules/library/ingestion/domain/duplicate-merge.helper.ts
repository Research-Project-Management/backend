import { Prisma, IngestionStatus } from '@prisma/client';
import { BadRequestException, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS, normalizeDoi } from '@/modules/library/core';
import { PrismaMergeAuditTrail } from '@/modules/library/ingestion/types/curation.types';

export type IngestionScope =
  | { userId?: string; projectId?: string | null }
  | string;

export function parseRunScope(
  scope?: IngestionScope,
  fallbackUserId?: string,
): { userId: string; projectId: string | null } {
  if (typeof scope === 'object' && scope !== null) {
    const rawProject = scope.projectId;
    const resolvedUserId = scope.userId || fallbackUserId;
    if (!resolvedUserId) {
      throw new BadRequestException(
        'User context (userId) is required for ingestion run operations',
      );
    }
    return {
      userId: resolvedUserId,
      projectId: rawProject && isUUID(rawProject) ? rawProject : null,
    };
  }
  const str = typeof scope === 'string' ? scope : '';
  const isProject =
    str &&
    str !== 'user' &&
    str !== 'me' &&
    str !== fallbackUserId &&
    isUUID(str);
  const resolvedUserId = fallbackUserId || (!isProject && str ? str : '');
  if (!resolvedUserId) {
    throw new BadRequestException(
      'User context (userId) is required for ingestion run operations',
    );
  }
  return {
    userId: resolvedUserId,
    projectId: isProject ? str : null,
  };
}

export function buildMergeAuditTrail(params: {
  primary: {
    id: string;
    doi?: string | null;
    citationKey?: string | null;
  };
  duplicates: Array<{ doi?: string | null }>;
  uniqueDupIds: string[];
  finalPrimary: unknown;
  primaryMeta: Record<string, unknown>;
  backfillFields: Record<string, unknown>;
  now: Date;
}): PrismaMergeAuditTrail {
  const {
    primary,
    duplicates,
    uniqueDupIds,
    finalPrimary,
    primaryMeta,
    backfillFields,
    now,
  } = params;
  const normPrimaryDoi = normalizeDoi(primary.doi);
  const matchReasons = Array.from(
    new Set(
      duplicates.map((dup) => {
        const normDupDoi = normalizeDoi(dup.doi);
        return normPrimaryDoi && normDupDoi && normPrimaryDoi === normDupDoi
          ? 'EXACT_DOI'
          : 'FUZZY_TITLE_YEAR_AUTHOR';
      }),
    ),
  );

  const preservedCitationKeys = Array.from(
    new Set(
      [
        (finalPrimary as { citationKey?: string | null }).citationKey ??
          primary.citationKey,
        ...(Array.isArray(primaryMeta.mergedCitationKeys)
          ? (primaryMeta.mergedCitationKeys as string[])
          : []),
      ].filter((k): k is string => typeof k === 'string' && k.length > 0),
    ),
  );

  const reloadedWithRelations = finalPrimary as {
    attachments?: unknown[];
    notesList?: unknown[];
    itemTags?: unknown[];
    collectionItems?: unknown[];
  };

  return {
    masterItemId: primary.id,
    mergedDuplicateIds: uniqueDupIds,
    matchReasons,
    preservedCitationKeys,
    consolidatedAttachments: Array.isArray(reloadedWithRelations.attachments)
      ? reloadedWithRelations.attachments.length
      : 0,
    consolidatedNotes: Array.isArray(reloadedWithRelations.notesList)
      ? reloadedWithRelations.notesList.length
      : 0,
    consolidatedTags: Array.isArray(reloadedWithRelations.itemTags)
      ? reloadedWithRelations.itemTags.length
      : 0,
    consolidatedCollections: Array.isArray(
      reloadedWithRelations.collectionItems,
    )
      ? reloadedWithRelations.collectionItems.length
      : 0,
    backfilledFields: Object.keys(backfillFields),
    timestamp: now.toISOString(),
  };
}

export async function invalidateMergedItemsCache(params: {
  cache?: RedisCacheService;
  logger: Logger;
  primaryId: string;
  uniqueDupIds: string[];
  userId: string;
  effectiveProjectId?: string;
}): Promise<void> {
  const { cache, logger, primaryId, uniqueDupIds, userId, effectiveProjectId } =
    params;
  if (!cache) return;
  try {
    const scopeId = effectiveProjectId || userId;
    const invalidationTasks: Promise<unknown>[] = [
      cache.del(LIBRARY_REDIS_KEYS.item(primaryId)),
      cache.del(LIBRARY_REDIS_KEYS.itemDetails(primaryId)),
      cache.del(LIBRARY_REDIS_KEYS.itemFulltext(primaryId)),
      cache.del(`library:item:${primaryId}:attachments`),
      cache.del(`library:item:${primaryId}:notes`),
      cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(primaryId)),
      cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(scopeId)),
      cache.delPattern(LIBRARY_REDIS_KEYS.countsPattern(scopeId)),
      cache.del(`library:counts:user:${userId}`),
      cache.del(LIBRARY_REDIS_KEYS.collections(scopeId)),
      cache.del(LIBRARY_REDIS_KEYS.collectionTree(scopeId)),
      cache.delPattern(LIBRARY_REDIS_KEYS.collectionsPattern(scopeId)),
      cache.del(LIBRARY_REDIS_KEYS.tags(scopeId)),
      cache.delPattern(LIBRARY_REDIS_KEYS.tagsPattern(scopeId)),
    ];
    for (const dupId of uniqueDupIds) {
      invalidationTasks.push(
        cache.del(LIBRARY_REDIS_KEYS.item(dupId)),
        cache.del(LIBRARY_REDIS_KEYS.itemDetails(dupId)),
        cache.del(LIBRARY_REDIS_KEYS.itemFulltext(dupId)),
        cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(dupId)),
      );
    }
    if (effectiveProjectId) {
      invalidationTasks.push(
        cache.delPattern(
          LIBRARY_REDIS_KEYS.itemsPattern(`proj:${effectiveProjectId}`),
        ),
        cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
        cache.del(`library:counts:proj:${effectiveProjectId}`),
        cache.delPattern(LIBRARY_REDIS_KEYS.collectionsPattern(userId)),
        cache.del(LIBRARY_REDIS_KEYS.tags(`proj:${effectiveProjectId}`)),
        cache.delPattern(
          LIBRARY_REDIS_KEYS.tagsPattern(`proj:${effectiveProjectId}`),
        ),
        cache.delPattern(LIBRARY_REDIS_KEYS.tagsPattern(userId)),
      );
    }
    await Promise.all(invalidationTasks);
  } catch (cacheErr: unknown) {
    const msg = cacheErr instanceof Error ? cacheErr.message : String(cacheErr);
    logger.warn(
      `Failed to invalidate Redis caches after merging items into ${primaryId}: ${msg}`,
    );
  }
}

export interface CreateIngestionRunData {
  id?: string;
  userId?: string;
  projectId?: string | null;
  traceId?: string | null;
  inputParams: Prisma.InputJsonValue;
  inputHash: string;
  idempotencyKey?: string | null;
  contractVersion?: string;
  pipelineVersion?: string;
  status?: IngestionStatus;
  nextRetryAt?: Date | null;
}
export interface CreateIngestionStageData {
  stageName: string;
  durationMs?: number;
  success?: boolean;
  errorMessage?: string;
  outputSnapshot?: Prisma.InputJsonValue;
  leaseToken?: string;
  leaseExpiresAt?: Date;
}
export interface CreateIngestionReviewCaseData {
  targetItemId?: string;
  reason: string;
  evidence?: Prisma.InputJsonValue;
  options?: Prisma.InputJsonValue;
  status?: string;
  resolution?: string;
  assignedToUserId?: string;
  assignedToId?: string;
}
