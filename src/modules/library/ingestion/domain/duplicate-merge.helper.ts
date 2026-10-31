import { Prisma, IngestionStatus } from '@prisma/client';
import { BadRequestException, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { RedisCacheService } from '@/core';
import {
  LIBRARY_REDIS_KEYS,
  normalizeDoi,
  TransactionHelpers,
} from '@/modules/library/core';
import { PrismaMergeAuditTrail } from '@/modules/library/ingestion/types/curation.types';

export type IngestionScope =
  { userId?: string; projectId?: string | null } | string;

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
      cache.del(LIBRARY_REDIS_KEYS.itemAttachments(primaryId)),
      cache.del(LIBRARY_REDIS_KEYS.itemNotes(primaryId)),
      cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(primaryId)),
      cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(scopeId)),
      cache.delPattern(LIBRARY_REDIS_KEYS.countsPattern(scopeId)),
      cache.delPattern(LIBRARY_REDIS_KEYS.countsPattern(userId)),
      cache.del(LIBRARY_REDIS_KEYS.counts(userId, effectiveProjectId)),
      cache.del(LIBRARY_REDIS_KEYS.collections(scopeId)),
      cache.del(LIBRARY_REDIS_KEYS.collectionTree(scopeId)),
      cache.delPattern(LIBRARY_REDIS_KEYS.collectionsPattern(scopeId)),
      cache.del(LIBRARY_REDIS_KEYS.tags(scopeId)),
      cache.delPattern(LIBRARY_REDIS_KEYS.tagsPattern(scopeId)),
      cache.delPattern(LIBRARY_REDIS_KEYS.searchFacetsPattern(scopeId)),
      cache.delPattern(LIBRARY_REDIS_KEYS.searchItemsPattern(scopeId)),
      cache.del(LIBRARY_REDIS_KEYS.searchVersion(scopeId)),
      cache.del(LIBRARY_REDIS_KEYS.savedSearches(scopeId)),
    ];
    for (const dupId of uniqueDupIds) {
      invalidationTasks.push(
        cache.del(LIBRARY_REDIS_KEYS.item(dupId)),
        cache.del(LIBRARY_REDIS_KEYS.itemDetails(dupId)),
        cache.del(LIBRARY_REDIS_KEYS.itemFulltext(dupId)),
        cache.del(LIBRARY_REDIS_KEYS.itemAttachments(dupId)),
        cache.del(LIBRARY_REDIS_KEYS.itemNotes(dupId)),
        cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(dupId)),
      );
    }
    if (effectiveProjectId) {
      invalidationTasks.push(
        cache.delPattern(
          LIBRARY_REDIS_KEYS.itemsPattern(`proj:${effectiveProjectId}`),
        ),
        cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
        cache.delPattern(LIBRARY_REDIS_KEYS.countsPattern(effectiveProjectId)),
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

export async function recordMergedAssetSyncEventsInTx(params: {
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  eventScope: { userId: string; projectId?: string };
  initialNotes: Array<{ id: string; itemId: string }>;
  initialAttachments: Array<{
    id: string;
    itemId: string;
    attachmentType?: string | null;
  }>;
}): Promise<void> {
  const { tx, helpers, eventScope, initialNotes, initialAttachments } = params;

  const survivingNotes =
    initialNotes.length > 0
      ? (await tx.note?.findMany?.({
          where: { id: { in: initialNotes.map((n) => n.id) } },
        })) || []
      : [];
  const survivingNoteMap = new Map(survivingNotes.map((n) => [n.id, n]));

  const assetChangeEntries: Array<{
    entityType: 'Note' | 'Attachment';
    entityId: string;
    action: 'update' | 'delete';
    version: number;
    data?: unknown;
  }> = [];
  const assetTombstones: Array<{
    entityType: 'Note' | 'Attachment';
    entityId: string;
  }> = [];

  for (const initNote of initialNotes) {
    const survivor = survivingNoteMap.get(initNote.id);
    if (survivor && !survivor.deletedAt) {
      assetChangeEntries.push({
        entityType: 'Note',
        entityId: survivor.id,
        action: 'update',
        version: 1,
        data: survivor,
      });
    } else {
      assetTombstones.push({
        entityType: 'Note',
        entityId: initNote.id,
      });
      assetChangeEntries.push({
        entityType: 'Note',
        entityId: initNote.id,
        action: 'delete',
        version: 0,
        data: { id: initNote.id, itemId: initNote.itemId },
      });
    }
  }

  const survivingAttachments =
    initialAttachments.length > 0
      ? (await tx.attachment?.findMany?.({
          where: { id: { in: initialAttachments.map((a) => a.id) } },
        })) || []
      : [];
  const survivingAttachmentMap = new Map(
    survivingAttachments.map((a) => [a.id, a]),
  );

  for (const initAtt of initialAttachments) {
    const survivor = survivingAttachmentMap.get(initAtt.id);
    if (survivor && !survivor.deletedAt) {
      assetChangeEntries.push({
        entityType: 'Attachment',
        entityId: survivor.id,
        action: 'update',
        version: 1,
        data: survivor,
      });
    } else {
      assetTombstones.push({
        entityType: 'Attachment',
        entityId: initAtt.id,
      });
      assetChangeEntries.push({
        entityType: 'Attachment',
        entityId: initAtt.id,
        action: 'delete',
        version: 0,
        data: { id: initAtt.id, itemId: initAtt.itemId },
      });
    }
  }

  if (assetTombstones.length > 0) {
    if (helpers.recordTombstonesBatch) {
      await helpers.recordTombstonesBatch(eventScope, assetTombstones);
    } else {
      for (const t of assetTombstones) {
        await helpers.recordTombstone(eventScope, t);
      }
    }
  }
  if (assetChangeEntries.length > 0) {
    if (helpers.appendChangesBatch) {
      await helpers.appendChangesBatch(eventScope, assetChangeEntries);
    } else {
      for (const c of assetChangeEntries) {
        await helpers.appendChange(eventScope, c);
      }
    }
  }
}

export async function updateAndReloadMergedPrimaryInTx(params: {
  tx: Prisma.TransactionClient;
  primaryId: string;
  userId: string;
  topLevelData: Record<string, unknown>;
  primaryMeta: Record<string, unknown>;
}) {
  const { tx, primaryId, userId, topLevelData, primaryMeta } = params;
  const updatedPrimary = await tx.item.update({
    where: { id: primaryId },
    data: {
      ...topLevelData,
      metadata: primaryMeta as Prisma.InputJsonValue,
      version: { increment: 1 },
    },
  });
  const reloadedPrimary = await tx.item.findUnique({
    where: { id: primaryId },
    include: {
      contributors: { orderBy: { orderIndex: 'asc' } },
      collectionItems: { include: { collection: true } },
      itemTags: { include: { tag: true } },
      notesList: { where: { deletedAt: null } },
      attachments: { include: { revisions: true } },
      identifiers: true,
      states: { where: { userId }, take: 1 },
    },
  });
  return { updatedPrimary, reloadedPrimary };
}

export async function softDeleteDuplicatesAndRecordOutboxInTx(params: {
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  eventScope: { userId: string; projectId?: string };
  primaryId: string;
  duplicates: Array<{ id: string; metadata?: unknown }>;
  userId: string;
  effectiveProjectId?: string;
  now: Date;
}): Promise<void> {
  const {
    tx,
    helpers,
    eventScope,
    primaryId,
    duplicates,
    userId,
    effectiveProjectId,
    now,
  } = params;

  const softDeletedDuplicates = await Promise.all(
    duplicates.map((dup) => {
      const baseMeta =
        dup.metadata &&
        typeof dup.metadata === 'object' &&
        !Array.isArray(dup.metadata)
          ? (dup.metadata as Record<string, unknown>)
          : {};
      const dupMeta = {
        ...baseMeta,
        mergedIntoId: primaryId,
        mergedAt: now.toISOString(),
      };
      return tx.item.update({
        where: { id: dup.id },
        data: {
          deletedAt: now,
          metadata: dupMeta,
          version: { increment: 1 },
        },
      });
    }),
  );

  const dupTombstones = duplicates.map((dup) => ({
    entityType: 'Item' as const,
    entityId: dup.id,
  }));
  const dupChangeEntries = duplicates.map((dup, idx) => ({
    entityType: 'Item' as const,
    entityId: dup.id,
    action: 'delete' as const,
    version: softDeletedDuplicates[idx].version,
    data: softDeletedDuplicates[idx],
  }));
  const dupOutboxEvents = duplicates.map((dup) => ({
    aggregateId: dup.id,
    eventType: 'library.item.merged_into',
    payload: {
      duplicateId: dup.id,
      primaryId,
      mergedIntoId: primaryId,
      reason: 'merged_into',
      userId,
      projectId: effectiveProjectId,
    },
  }));

  if (helpers.recordTombstonesBatch) {
    await helpers.recordTombstonesBatch(eventScope, dupTombstones);
  } else {
    for (const t of dupTombstones) {
      await helpers.recordTombstone(eventScope, t);
    }
  }

  if (helpers.appendChangesBatch) {
    await helpers.appendChangesBatch(eventScope, dupChangeEntries);
  } else {
    for (const c of dupChangeEntries) {
      await helpers.appendChange(eventScope, c);
    }
  }

  if (helpers.publishOutboxBatch) {
    await helpers.publishOutboxBatch(eventScope, dupOutboxEvents);
  } else {
    for (const ev of dupOutboxEvents) {
      await helpers.publishOutbox(
        eventScope,
        ev.aggregateId,
        ev.eventType,
        ev.payload,
      );
    }
  }
}
