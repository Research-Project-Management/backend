import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisCacheService } from '@/core';
import { asMetaObject } from '@/modules/library/ingestion/domain/duplicate-clustering.helper';
import {
  normalizeProjectScopeId, ItemProvenancePolicy, deriveFirstAuthor,
  executeStandardLibraryCacheInvalidation, ICatalogFacade, IItemCacheInvalidator,
  LIBRARY_REDIS_KEYS, TransactionHelpers,
} from '@/modules/library/core';
import {
  ContributorShape, IDENTIFIER_META_KEYS, RETRACTION_SURVIVAL_KEYS,
  SYSTEM_RESERVED_MERGE_KEYS, TOP_LEVEL_ITEM_COLUMNS, VENUE_ALIAS_MERGE_KEYS,
  buildMergeAuditTrail, planMergedItemRelations, mapContributorInputForPrimary,
  syncContributorsToMeta, extractItemContributors, selectBestDonorContributors,
  shouldUpgradePrimaryContributors, computeClearedCanonicalIdentifierTypes,
  computeDesiredMergedIdentifierRecords, applyMetadataAndProvenanceBackfill,
  computeMergedTopLevelAndPrimaryMeta,
} from '@/modules/library/ingestion/domain/duplicate-merge.domain';

export type { ContributorShape };
export {
  IDENTIFIER_META_KEYS, RETRACTION_SURVIVAL_KEYS, SYSTEM_RESERVED_MERGE_KEYS,
  TOP_LEVEL_ITEM_COLUMNS, VENUE_ALIAS_MERGE_KEYS, buildMergeAuditTrail,
};

export interface IngestionItemCacheInvalidationParams {
  itemIds: string[]; userId?: string | null; projectId?: string | null;
  cacheCoordinator?: IItemCacheInvalidator; catalogGateway?: ICatalogFacade;
  cache?: RedisCacheService; logger?: Logger; includeExtendedRelations?: boolean; contextLabel?: string;
}

export async function invalidateIngestionItemCache(params: IngestionItemCacheInvalidationParams): Promise<void> {
  const { itemIds, userId, projectId, cacheCoordinator, catalogGateway, cache, logger, includeExtendedRelations, contextLabel } = params;
  if (!itemIds || itemIds.length === 0) return;
  const validProjectId = normalizeProjectScopeId(projectId);
  const invalidator = cacheCoordinator?.invalidateForWrite ? cacheCoordinator : catalogGateway?.invalidateForWrite ? catalogGateway : undefined;
  const extraKeys: string[] = [];
  if (includeExtendedRelations && !(invalidator?.invalidateForWrite && userId)) {
    const scopeKeys = new Set<string>();
    const scopeId = validProjectId || userId || undefined;
    if (scopeId) scopeKeys.add(scopeId);
    if (validProjectId) scopeKeys.add(`proj:${validProjectId}`);
    if (userId) scopeKeys.add(userId);
    for (const key of scopeKeys) extraKeys.push(LIBRARY_REDIS_KEYS.collections(key), LIBRARY_REDIS_KEYS.collectionTree(key));
    if (userId) extraKeys.push(LIBRARY_REDIS_KEYS.counts(userId, validProjectId));
  }
  await executeStandardLibraryCacheInvalidation(
    invalidator, cache,
    { userId: userId ?? undefined, projectId: validProjectId, itemIds, extraKeys: extraKeys.length > 0 ? extraKeys : undefined },
    (msg) => logger?.warn(`Failed to invalidate Redis caches${contextLabel ? ` (${contextLabel})` : ''}: ${msg}`),
  );
}

export async function invalidateMergedItemsCache(params: {
  cache?: RedisCacheService; cacheCoordinator?: IItemCacheInvalidator; catalogGateway?: ICatalogFacade;
  logger: Logger; primaryId: string; uniqueDupIds: string[]; userId: string; effectiveProjectId?: string;
}): Promise<void> {
  const { cache, cacheCoordinator, catalogGateway, logger, primaryId, uniqueDupIds, userId, effectiveProjectId } = params;
  await invalidateIngestionItemCache({
    itemIds: [primaryId, ...uniqueDupIds], userId, projectId: effectiveProjectId,
    cacheCoordinator, catalogGateway, cache, logger, includeExtendedRelations: true, contextLabel: `after merging items into ${primaryId}`,
  });
}

export async function syncMergedContributors(
  tx: Prisma.TransactionClient,
  primaryId: string,
  chosenContributors: ContributorShape[] | string[] | undefined,
  duplicates: Array<{ contributors?: unknown; metadata?: unknown }>,
  primary?: Record<string, unknown> & { contributors?: unknown; metadata?: unknown },
  primaryMeta?: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const mapInput = (c: ContributorShape | string, idx: number) => mapContributorInputForPrimary(primaryId, c, idx);

  if (Array.isArray(chosenContributors)) {
    await tx.contributor.deleteMany({ where: { itemId: primaryId } });
    if (chosenContributors.length === 0) {
      syncContributorsToMeta(primaryMeta, []);
      return [];
    }
    const data = chosenContributors.map(mapInput);
    await tx.contributor.createMany({ data });
    syncContributorsToMeta(primaryMeta, data);
    return data;
  }

  const effectivePrimaryMeta = primaryMeta ?? asMetaObject(primary?.metadata);
  const isPrimaryCreatorsLocked = ItemProvenancePolicy.isFieldLocked(
    effectivePrimaryMeta, 'creators', ['authors', 'contributors'],
  );

  if (!isPrimaryCreatorsLocked) {
    for (const dup of duplicates) {
      const dupMeta = asMetaObject(dup.metadata);
      const locked =
        ItemProvenancePolicy.inspectFieldUserLock(dupMeta, 'creators').locked ||
        ItemProvenancePolicy.inspectFieldUserLock(dupMeta, 'authors').locked;
      if (locked) {
        const dupContribs = extractItemContributors(dup);
        if (dupContribs.length > 0) {
          await tx.contributor.deleteMany({ where: { itemId: primaryId } });
          const data = dupContribs.map(mapInput);
          await tx.contributor.createMany({ data });
          syncContributorsToMeta(primaryMeta, data);
          if (primaryMeta) {
            const existingLocked = Array.isArray(primaryMeta.lockedFields) ? (primaryMeta.lockedFields as string[]) : [];
            primaryMeta.lockedFields = Array.from(new Set([...existingLocked, 'creators', 'authors']));
          }
          return data;
        }
      }
    }
  }

  const primaryContribCount =
    typeof tx.contributor?.count === 'function' ? await tx.contributor.count({ where: { itemId: primaryId } }) : 0;
  const primaryContribs = extractItemContributors(primary);
  const bestDonor = selectBestDonorContributors(duplicates);
  if (!bestDonor) return [];

  if (primaryContribCount === 0 && primaryContribs.length === 0) {
    const data = bestDonor.list.map(mapInput);
    await tx.contributor.createMany({ data });
    syncContributorsToMeta(primaryMeta, data);
    return data;
  }

  if (
    !isPrimaryCreatorsLocked &&
    primaryContribs.length > 0 &&
    shouldUpgradePrimaryContributors(primary, effectivePrimaryMeta, primaryContribs, bestDonor)
  ) {
    await tx.contributor.deleteMany({ where: { itemId: primaryId } });
    const data = bestDonor.list.map(mapInput);
    await tx.contributor.createMany({ data });
    syncContributorsToMeta(primaryMeta, data);
    return data;
  }

  return [];
}

export async function syncMergedIdentifiersInTx(params: {
  tx: Prisma.TransactionClient;
  primaryId: string;
  uniqueDupIds: string[];
  primaryMeta: Record<string, unknown>;
  topLevelData: Record<string, unknown>;
  primaryDoi?: string | null;
  explicitlyClearedFields?: ReadonlySet<string>;
}): Promise<void> {
  const { tx, primaryId, uniqueDupIds, primaryMeta, topLevelData, primaryDoi, explicitlyClearedFields } = params;
  const identTx = tx as unknown as {
    itemIdentifier?: {
      findMany?: (args: { where: { itemId: { in: string[] } } }) => Promise<
        Array<{ itemId: string; type: string; value: string; canonicalUri?: string | null }>
      >;
      upsert?: (args: {
        where: { itemId_type: { itemId: string; type: string } };
        update: { value: string; canonicalUri: string };
        create: { itemId: string; type: string; value: string; canonicalUri: string };
      }) => Promise<unknown>;
      deleteMany?: (args: { where: Record<string, unknown> }) => Promise<unknown>;
    };
  };

  const clearedCanonicalTypes = computeClearedCanonicalIdentifierTypes(
    topLevelData, primaryMeta, explicitlyClearedFields,
  );
  if (!identTx.itemIdentifier) return;

  const existingIdRecords = identTx.itemIdentifier.findMany
    ? await identTx.itemIdentifier.findMany({ where: { itemId: { in: [primaryId, ...uniqueDupIds] } } })
    : [];

  const desiredByType = computeDesiredMergedIdentifierRecords({
    primaryId, existingIdRecords, clearedCanonicalTypes, topLevelData, primaryMeta, primaryDoi,
  });

  if (identTx.itemIdentifier.deleteMany && uniqueDupIds.length > 0) {
    await identTx.itemIdentifier.deleteMany({ where: { itemId: { in: uniqueDupIds } } });
  }
  if (identTx.itemIdentifier.deleteMany && clearedCanonicalTypes.size > 0) {
    await identTx.itemIdentifier.deleteMany({
      where: { itemId: primaryId, type: { in: Array.from(clearedCanonicalTypes) } },
    });
  }
  if (identTx.itemIdentifier.upsert) {
    await Promise.all(
      Array.from(desiredByType.values(), (idObj) =>
        identTx.itemIdentifier!.upsert!({
          where: { itemId_type: { itemId: primaryId, type: idObj.type } },
          update: { value: idObj.value, canonicalUri: idObj.canonicalUri },
          create: { itemId: primaryId, ...idObj },
        }),
      ),
    );
  }
}

export async function rewireMergedItemRelations(
  tx: Prisma.TransactionClient,
  primaryId: string,
  uniqueDupIds: string[],
): Promise<Array<Record<string, unknown>>> {
  const existingRelations =
    (await tx.itemRelation?.findMany?.({
      where: {
        OR: [
          { sourceItemId: { in: [primaryId, ...uniqueDupIds] } },
          { targetItemId: { in: [primaryId, ...uniqueDupIds] } },
        ],
      },
    })) ?? [];

  const { relationIdsToDelete, relationUpdates } = planMergedItemRelations(existingRelations, primaryId, uniqueDupIds);

  if (relationUpdates.length > 0) {
    await Promise.all(
      relationUpdates.map((upd) =>
        tx.itemRelation.update({
          where: { id: upd.id },
          data: { sourceItemId: upd.sourceItemId, targetItemId: upd.targetItemId },
        }),
      ),
    );
  }
  if (relationIdsToDelete.length > 0) {
    if (tx.itemRelation.deleteMany) {
      await tx.itemRelation.deleteMany({ where: { id: { in: relationIdsToDelete } } });
    } else {
      await Promise.all(relationIdsToDelete.map((relId) => tx.itemRelation.delete({ where: { id: relId } })));
    }
  }
  return existingRelations;
}

export async function consolidateUserPublications(
  tx: Prisma.TransactionClient,
  primaryId: string,
  uniqueDupIds: string[],
): Promise<{ dupPublications: Array<Record<string, unknown>>; primaryPublications: Array<Record<string, unknown>> }> {
  const dupPublications = (await tx.userPublication?.findMany?.({ where: { itemId: { in: uniqueDupIds } } })) ?? [];
  if (dupPublications.length === 0) return { dupPublications: [], primaryPublications: [] };

  const primaryPubByUser = new Map<string, (typeof dupPublications)[number]>();
  const initialPrimaryPubs: Array<Record<string, unknown>> = [];

  if (typeof tx.userPublication?.findMany === 'function') {
    const existingPrimaryPubs = (await tx.userPublication.findMany({ where: { itemId: primaryId } })) ?? [];
    for (const p of existingPrimaryPubs) {
      if (!p.itemId || p.itemId === primaryId) {
        primaryPubByUser.set(p.userId, p);
        initialPrimaryPubs.push({ ...(p as unknown as Record<string, unknown>) });
      }
    }
  } else if (typeof tx.userPublication?.findUnique === 'function') {
    for (const uid of new Set(dupPublications.map((p) => p.userId))) {
      const existing = await tx.userPublication.findUnique({ where: { userId_itemId: { userId: uid, itemId: primaryId } } });
      if (existing) {
        primaryPubByUser.set(uid, existing);
        initialPrimaryPubs.push({ ...(existing as unknown as Record<string, unknown>) });
      }
    }
  }

  for (const pub of dupPublications) {
    const existingPrimaryPub = primaryPubByUser.get(pub.userId) ?? null;

    if (!existingPrimaryPub) {
      const created = await tx.userPublication.create({
        data: {
          userId: pub.userId,
          itemId: primaryId,
          contributorId: pub.contributorId,
          isPublic: pub.isPublic,
          openAccessLicense: pub.openAccessLicense,
          addedAt: pub.addedAt,
        },
      });
      primaryPubByUser.set(pub.userId, created ?? { ...pub, itemId: primaryId });
    } else {
      const updatedData = {
        isPublic: existingPrimaryPub.isPublic || pub.isPublic,
        openAccessLicense: existingPrimaryPub.openAccessLicense || pub.openAccessLicense,
        contributorId: existingPrimaryPub.contributorId || pub.contributorId,
      };
      await tx.userPublication.update({
        where: { userId_itemId: { userId: pub.userId, itemId: primaryId } },
        data: updatedData,
      });
      primaryPubByUser.set(pub.userId, { ...existingPrimaryPub, ...updatedData });
    }
  }

  if (tx.userPublication.deleteMany) {
    await tx.userPublication.deleteMany({ where: { itemId: { in: uniqueDupIds } } });
  } else {
    for (const pub of dupPublications) {
      await tx.userPublication.delete({ where: { userId_itemId: { userId: pub.userId, itemId: pub.itemId } } });
    }
  }

  return {
    dupPublications: dupPublications as unknown as Array<Record<string, unknown>>,
    primaryPublications: initialPrimaryPubs,
  };
}

export async function applyMergedUpdatesAndClearDuplicateCitationKeyCollision(params: {
  tx: Prisma.TransactionClient;
  primary: Record<string, unknown>;
  duplicates: Array<Record<string, unknown>>;
  effectiveMergedItemType?: string;
  derivedFirstAuthor?: string | null;
  finalContributors?: Array<Record<string, unknown>>;
  noteCount?: number;
  attachmentCount?: number;
  backfillFields: Record<string, unknown>;
  scalarSelections: Record<string, unknown>;
  primaryMeta: Record<string, unknown>;
}): Promise<{ topLevelData: Record<string, unknown> }> {
  const { tx, duplicates } = params;
  const topLevelData = computeMergedTopLevelAndPrimaryMeta(params);

  if (typeof topLevelData.citationKey === 'string' && topLevelData.citationKey.trim()) {
    const targetCitKey = topLevelData.citationKey.trim().toLowerCase();
    const collidingDupIds = duplicates
      .filter((dup) => typeof dup.citationKey === 'string' && dup.citationKey.trim().toLowerCase() === targetCitKey && typeof dup.id === 'string')
      .map((dup) => dup.id as string);
    if (collidingDupIds.length > 0) {
      if (typeof tx.item?.updateMany === 'function') {
        await tx.item.updateMany({ where: { id: { in: collidingDupIds } }, data: { citationKey: null } });
      } else if (typeof tx.item?.update === 'function') {
        for (const dupId of collidingDupIds) {
          await tx.item.update({ where: { id: dupId }, data: { citationKey: null } });
        }
      }
    }
  }

  return { topLevelData };
}

export type MergePipelineContext = DuplicateMergeStepContext;

export interface DuplicateMergeStepContext {
  tx: Prisma.TransactionClient;
  primary: Record<string, unknown> & { id: string; citationKey?: string | null; metadata?: unknown };
  duplicates: Array<
    Record<string, unknown> & {
      id: string;
      citationKey?: string | null;
      doi?: string | null;
      metadata?: unknown;
      contributors?: unknown;
    }
  >;
  uniqueDupIds: string[];
  rawSelections: Record<string, unknown>;
  scalarSelections: Record<string, unknown>;
  primaryMeta: Record<string, unknown>;
  backfillFields: Record<string, unknown>;
  offloadedFileIdsToDelete: string[];
  syncedContributors?: Array<Record<string, unknown>>;
  now: Date;
}

export type DuplicateMergeStepFn = (context: DuplicateMergeStepContext) => Promise<void> | void;

export async function consolidateItemMetadataStep(ctx: DuplicateMergeStepContext): Promise<void> {
  const { tx, primary, uniqueDupIds } = ctx;
  const [primaryMetaRows, dupMetas] = await Promise.all([
    tx.itemMetadata?.findMany
      ? tx.itemMetadata.findMany({ where: { itemId: primary.id } })
      : (async () => {
          const first = await tx.itemMetadata?.findFirst?.({ where: { itemId: primary.id } });
          return first ? [first] : [];
        })(),
    tx.itemMetadata?.findMany
      ? tx.itemMetadata.findMany({
          where: { itemId: { in: uniqueDupIds } },
          select: { id: true, itemId: true, sourceProvider: true, rawPayload: true },
        })
      : Promise.resolve([]),
  ]);

  const resolvedPrimaryMetas = Array.isArray(primaryMetaRows) ? primaryMetaRows : [];
  const resolvedDupMetas =
    dupMetas.length > 0
      ? dupMetas
      : tx.itemMetadata?.findFirst
        ? await (async () => {
            const firstDup = await tx.itemMetadata.findFirst({ where: { itemId: { in: uniqueDupIds } } });
            return firstDup ? [firstDup] : [];
          })()
        : [];

  const coveredProviders = new Set<string>(
    resolvedPrimaryMetas
      .map((m) =>
        typeof (m as { sourceProvider?: unknown }).sourceProvider === 'string'
          ? (m as { sourceProvider: string }).sourceProvider.trim().toLowerCase()
          : '',
      )
      .filter(Boolean),
  );

  const idsToReassign: string[] = [];
  for (const dm of resolvedDupMetas) {
    const dmRec = dm as { id?: string; itemId?: string; sourceProvider?: string };
    if (!dmRec.id) continue;
    const providerKey =
      typeof dmRec.sourceProvider === 'string' && dmRec.sourceProvider.trim()
        ? dmRec.sourceProvider.trim().toLowerCase()
        : '';
    const shouldReassign =
      providerKey.length > 0 ? !coveredProviders.has(providerKey) : resolvedPrimaryMetas.length === 0;

    if (shouldReassign) {
      if (providerKey) coveredProviders.add(providerKey);
      idsToReassign.push(dmRec.id);
    }
  }
  if (idsToReassign.length > 0) {
    if (typeof tx.itemMetadata?.updateMany === 'function') {
      await tx.itemMetadata.updateMany({ where: { id: { in: idsToReassign } }, data: { itemId: primary.id } });
    } else if (typeof tx.itemMetadata?.update === 'function') {
      for (const id of idsToReassign) {
        await tx.itemMetadata.update({ where: { id }, data: { itemId: primary.id } });
      }
    }
  }
}

export async function backfillMetadataAndCreatorsStep(ctx: DuplicateMergeStepContext): Promise<void> {
  const { tx, primary, duplicates, rawSelections, scalarSelections, primaryMeta, backfillFields } = ctx;

  const extraIsObject =
    primaryMeta.extra !== null && typeof primaryMeta.extra === 'object' && !Array.isArray(primaryMeta.extra);
  const extraObj: Record<string, unknown> | undefined = extraIsObject
    ? { ...(primaryMeta.extra as Record<string, unknown>) }
    : undefined;

  const existingAliases: string[] = [
    ...(Array.isArray(primaryMeta.mergedCitationKeys) ? (primaryMeta.mergedCitationKeys as string[]) : []),
    ...(extraObj && Array.isArray(extraObj.mergedCitationKeys) ? (extraObj.mergedCitationKeys as string[]) : []),
  ];
  const dupCitationKeys = duplicates
    .flatMap((d) => {
      const dMeta = asMetaObject(d.metadata);
      const dAliases = Array.isArray(dMeta.mergedCitationKeys) ? (dMeta.mergedCitationKeys as string[]) : [];
      return [d.citationKey, ...dAliases];
    })
    .filter((k): k is string => Boolean(k?.trim() && k !== primary.citationKey));
  const mergedAliases = Array.from(new Set([...existingAliases, ...dupCitationKeys]));
  primaryMeta.mergedCitationKeys = mergedAliases;
  if (extraObj) extraObj.mergedCitationKeys = mergedAliases;

  const chosenContributors = (rawSelections.contributors ?? rawSelections.authors ?? rawSelections.creators) as
    | ContributorShape[]
    | string[]
    | undefined;

  const syncedContributors = await syncMergedContributors(
    tx, primary.id, chosenContributors, duplicates, primary, primaryMeta,
  );
  if (Array.isArray(chosenContributors) && chosenContributors.length === 0) {
    ctx.syncedContributors = [];
    backfillFields.firstAuthor = null;
  } else if (syncedContributors.length > 0) {
    ctx.syncedContributors = syncedContributors;
    const derivedAuthor = deriveFirstAuthor({
      contributors: syncedContributors,
      itemType: String(scalarSelections.itemType || primary.itemType || primary.type || ''),
    });
    if (derivedAuthor) backfillFields.firstAuthor = derivedAuthor;
  }

  applyMetadataAndProvenanceBackfill({
    primary, duplicates, scalarSelections, primaryMeta, backfillFields, extraObj,
  });
}

export function applyRetractionSurvivalStep(ctx: DuplicateMergeStepContext): void {
  const { duplicates, uniqueDupIds, primaryMeta, backfillFields, now } = ctx;

  for (const dup of duplicates) {
    const dupMeta = asMetaObject(dup.metadata);
    if (dupMeta.isMyPublication === true) {
      primaryMeta.isMyPublication = true;
      for (const pubKey of ['publicationConfirmedAt', 'openAccessLicense', 'isPublicPublication'] as const) {
        if (primaryMeta[pubKey] === undefined && dupMeta[pubKey] !== undefined) {
          primaryMeta[pubKey] = dupMeta[pubKey];
        }
      }
    }

    if (
      (dup as { isRetracted?: boolean }).isRetracted ||
      dupMeta.isRetracted ||
      dupMeta.retraction ||
      dupMeta.retractionNature ||
      dupMeta.retractionDetails
    ) {
      primaryMeta.isRetracted = true;
      for (const rKey of RETRACTION_SURVIVAL_KEYS) {
        if (!primaryMeta[rKey] && dupMeta[rKey] !== undefined) {
          primaryMeta[rKey] = dupMeta[rKey];
        }
      }
    } else if (!primaryMeta.retractionCheckedAt && dupMeta.retractionCheckedAt) {
      primaryMeta.retractionCheckedAt = dupMeta.retractionCheckedAt;
    }
  }

  const currentHistory = Array.isArray(primaryMeta.mergeHistory) ? (primaryMeta.mergeHistory as unknown[]) : [];
  primaryMeta.mergeHistory = [
    ...currentHistory,
    { mergedAt: now.toISOString(), duplicateItemIds: uniqueDupIds, backfilledFields: Object.keys(backfillFields) },
  ];
}

export const DEFAULT_DUPLICATE_MERGE_STEPS: readonly DuplicateMergeStepFn[] = [
  consolidateItemMetadataStep,
  backfillMetadataAndCreatorsStep,
  applyRetractionSurvivalStep,
];

export async function executeDuplicateMergePipeline(
  context: DuplicateMergeStepContext,
  steps: readonly DuplicateMergeStepFn[] = DEFAULT_DUPLICATE_MERGE_STEPS,
): Promise<void> {
  for (const step of steps) {
    await step(context);
  }
}

export async function recordMergedAssetSyncEventsInTx(params: {
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  eventScope: { userId: string; projectId?: string };
  initialNotes: Array<{ id: string; itemId: string }>;
  initialAttachments: Array<{ id: string; itemId: string; attachmentType?: string | null }>;
}): Promise<void> {
  const { tx, helpers, eventScope, initialNotes, initialAttachments } = params;

  const survivingNotes =
    initialNotes.length > 0
      ? (await tx.note?.findMany?.({ where: { id: { in: initialNotes.map((n) => n.id) } } })) || []
      : [];
  const survivingNoteMap = new Map(survivingNotes.map((n) => [n.id, n]));

  const assetChangeEntries: Array<{
    entityType: 'Note' | 'Attachment';
    entityId: string;
    action: 'update' | 'delete';
    version: number;
    data?: unknown;
  }> = [];
  const assetTombstones: Array<{ entityType: 'Note' | 'Attachment'; entityId: string }> = [];

  for (const initNote of initialNotes) {
    const survivor = survivingNoteMap.get(initNote.id);
    if (survivor && !survivor.deletedAt) {
      assetChangeEntries.push({ entityType: 'Note', entityId: survivor.id, action: 'update', version: 1, data: survivor });
    } else {
      assetTombstones.push({ entityType: 'Note', entityId: initNote.id });
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
      ? (await tx.attachment?.findMany?.({ where: { id: { in: initialAttachments.map((a) => a.id) } } })) || []
      : [];
  const survivingAttachmentMap = new Map(survivingAttachments.map((a) => [a.id, a]));

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
      assetTombstones.push({ entityType: 'Attachment', entityId: initAtt.id });
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
    if (helpers.recordTombstonesBatch) await helpers.recordTombstonesBatch(eventScope, assetTombstones);
    else for (const t of assetTombstones) await helpers.recordTombstone(eventScope, t);
  }
  if (assetChangeEntries.length > 0) {
    if (helpers.appendChangesBatch) await helpers.appendChangesBatch(eventScope, assetChangeEntries);
    else for (const c of assetChangeEntries) await helpers.appendChange(eventScope, c);
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
    data: { ...topLevelData, metadata: primaryMeta as Prisma.InputJsonValue, version: { increment: 1 } },
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
  const { tx, helpers, eventScope, primaryId, duplicates, userId, effectiveProjectId, now } = params;

  const softDeletedDuplicates = await Promise.all(
    duplicates.map((dup) => {
      const baseMeta =
        dup.metadata && typeof dup.metadata === 'object' && !Array.isArray(dup.metadata)
          ? (dup.metadata as Record<string, unknown>)
          : {};
      const dupMeta = { ...baseMeta, mergedIntoId: primaryId, mergedAt: now.toISOString() };
      return tx.item.update({
        where: { id: dup.id },
        data: { deletedAt: now, metadata: dupMeta, version: { increment: 1 } },
      });
    }),
  );

  const dupTombstones = duplicates.map((dup) => ({ entityType: 'Item' as const, entityId: dup.id }));
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

  if (helpers.recordTombstonesBatch) await helpers.recordTombstonesBatch(eventScope, dupTombstones);
  else for (const t of dupTombstones) await helpers.recordTombstone(eventScope, t);

  if (helpers.appendChangesBatch) await helpers.appendChangesBatch(eventScope, dupChangeEntries);
  else for (const c of dupChangeEntries) await helpers.appendChange(eventScope, c);

  if (helpers.publishOutboxBatch) await helpers.publishOutboxBatch(eventScope, dupOutboxEvents);
  else {
    for (const ev of dupOutboxEvents) {
      await helpers.publishOutbox(eventScope, ev.aggregateId, ev.eventType, ev.payload);
    }
  }
}

@Injectable()
export class DuplicateMergeRepository {
  readonly rewireMergedItemRelations = rewireMergedItemRelations;
  readonly consolidateUserPublications = consolidateUserPublications;
  readonly syncMergedContributors = syncMergedContributors;
  readonly syncMergedIdentifiersInTx = syncMergedIdentifiersInTx;
  readonly applyMergedUpdatesAndClearDuplicateCitationKeyCollision =
    applyMergedUpdatesAndClearDuplicateCitationKeyCollision;
  readonly consolidateItemMetadataStep = consolidateItemMetadataStep;
  readonly backfillMetadataAndCreatorsStep = backfillMetadataAndCreatorsStep;
  readonly applyRetractionSurvivalStep = applyRetractionSurvivalStep;
  readonly executeDuplicateMergePipeline = executeDuplicateMergePipeline;
  readonly recordMergedAssetSyncEventsInTx = recordMergedAssetSyncEventsInTx;
  readonly updateAndReloadMergedPrimaryInTx = updateAndReloadMergedPrimaryInTx;
  readonly softDeleteDuplicatesAndRecordOutboxInTx = softDeleteDuplicatesAndRecordOutboxInTx;
  readonly invalidateIngestionItemCache = invalidateIngestionItemCache;
  readonly invalidateMergedItemsCache = invalidateMergedItemsCache;
}
