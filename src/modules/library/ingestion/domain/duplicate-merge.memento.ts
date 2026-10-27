import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import {
  PRISMA_ITEM_SCALAR_COLUMNS,
  TransactionHelpers,
  LIBRARY_EVENT_TYPES,
} from '@/modules/library/core';
import { ItemsMapper } from '@/modules/library/catalog';
import {
  MementoIdentifierRecord,
  MementoContributorRecord,
  MementoItemRelationRecord,
  MementoUserPublicationRecord,
  MementoUserStateRecord,
  MementoItemMetadataRecord,
  MementoAttachmentRecord,
  PreMergeItemRelations,
  MasterItemSnapshot,
  MasterPreMergeSnapshot,
  MergedDuplicateSnapshot,
  asPlainObject,
  asStringArray,
  extractIdentifiers,
  extractContributors,
  extractItemRelations,
  extractUserPublications,
  extractUserStates,
  extractItemMetadata,
  extractAttachments,
  capturePreMergeRelationsInTx,
  attachCapturedMergeStepRelations,
  restoreMasterRelationsInTx,
  restoreDuplicateRelationsInTx,
} from './duplicate-merge-relations.memento';

export type {
  MementoIdentifierRecord,
  MementoContributorRecord,
  MementoItemRelationRecord,
  MementoUserPublicationRecord,
  MementoUserStateRecord,
  MementoItemMetadataRecord,
  MementoAttachmentRecord,
  PreMergeItemRelations,
  MasterItemSnapshot,
  MasterPreMergeSnapshot,
  MergedDuplicateSnapshot,
};

export {
  capturePreMergeRelationsInTx,
  attachCapturedMergeStepRelations,
  restoreMasterRelationsInTx,
  restoreDuplicateRelationsInTx,
};

export interface DuplicateMergeMemento {
  readonly schemaVersion: 1 | 2 | 3;
  readonly masterItemId: string;
  readonly mergedDuplicateIds: string[];
  readonly mergedAt: string;
  readonly beforeMaster?: MasterItemSnapshot;
  readonly mergedDuplicates?: MergedDuplicateSnapshot[];
  readonly reassignedAssetIds?: {
    noteIds?: string[];
    attachmentIds?: string[];
  };
  readonly mergedMetadataFields?: string[];
  readonly mergedCreatorCount?: number;
}

const RESTORABLE_MASTER_SCALAR_KEYS = new Set<string>(
  PRISMA_ITEM_SCALAR_COLUMNS,
);

export function createDuplicateMergeMemento(params: {
  primary: Record<string, unknown> & { id: string };
  duplicates: Array<Record<string, unknown> & { id: string }>;
  uniqueDupIds: string[];
  mergedMetadataFields?: string[];
  reassignedNoteIds?: string[];
  reassignedAttachmentIds?: string[];
  mergedCreatorCount?: number;
  primaryRelations?: PreMergeItemRelations;
  duplicateRelationsById?: Record<string, PreMergeItemRelations>;
  schemaVersion?: 2 | 3;
  now?: Date;
}): DuplicateMergeMemento {
  const {
    primary,
    duplicates,
    uniqueDupIds,
    mergedMetadataFields = [],
    reassignedNoteIds = [],
    reassignedAttachmentIds = [],
    mergedCreatorCount = 0,
    primaryRelations,
    duplicateRelationsById,
    now = new Date(),
  } = params;

  const masterAttachmentIds = primaryRelations?.attachmentIds ?? asStringArray(primary.attachmentIds);
  const masterAttachments = primaryRelations?.attachments ?? extractAttachments(primary.attachments);
  const masterTagIds = primaryRelations?.tagIds ?? asStringArray(primary.tagIds);
  const masterCollectionIds = primaryRelations?.collectionIds ?? asStringArray(primary.collectionIds);
  const masterContributors = primaryRelations?.contributors ?? extractContributors(primary.contributors);
  const masterIdentifiers = primaryRelations?.identifiers ?? extractIdentifiers(primary.identifiers);
  const masterItemRelations = primaryRelations?.itemRelations ?? extractItemRelations(primary.itemRelations);
  const masterUserPublications = primaryRelations?.userPublications ?? extractUserPublications(primary.userPublications);
  const masterUserStates = primaryRelations?.userStates ?? extractUserStates(primary.userStates ?? primary.states);
  const masterItemMetadata = primaryRelations?.itemMetadata ?? extractItemMetadata(primary.itemMetadata);

  const beforeMaster: MasterItemSnapshot = {
    id: primary.id,
    metadata: { ...asPlainObject(primary.metadata) },
    ...(masterAttachmentIds !== undefined ? { attachmentIds: [...masterAttachmentIds] } : {}),
    ...(masterAttachments !== undefined ? { attachments: [...masterAttachments] } : {}),
    ...(masterTagIds !== undefined ? { tagIds: [...masterTagIds] } : {}),
    ...(masterCollectionIds !== undefined ? { collectionIds: [...masterCollectionIds] } : {}),
    ...(masterContributors !== undefined ? { contributors: [...masterContributors] } : {}),
    ...(masterIdentifiers !== undefined ? { identifiers: [...masterIdentifiers] } : {}),
    ...(masterItemRelations !== undefined ? { itemRelations: [...masterItemRelations] } : {}),
    ...(masterUserPublications !== undefined ? { userPublications: [...masterUserPublications] } : {}),
    ...(masterUserStates !== undefined ? { userStates: [...masterUserStates] } : {}),
    ...(masterItemMetadata !== undefined ? { itemMetadata: [...masterItemMetadata] } : {}),
  };
  for (const col of RESTORABLE_MASTER_SCALAR_KEYS) {
    if (col in primary && primary[col] !== undefined) {
      beforeMaster[col] = primary[col];
    }
  }
  if (beforeMaster.attachmentCount === undefined && (masterAttachmentIds !== undefined || masterAttachments !== undefined)) {
    const count = masterAttachmentIds?.length ?? masterAttachments?.length ?? 0;
    beforeMaster.attachmentCount = count;
    if (beforeMaster.hasFile === undefined) {
      beforeMaster.hasFile = count > 0;
    }
  }

  let hasV3Relations = Boolean(
    masterItemRelations !== undefined ||
      masterUserPublications !== undefined ||
      masterUserStates !== undefined ||
      masterItemMetadata !== undefined,
  );

  const mergedDuplicates: MergedDuplicateSnapshot[] = duplicates.map((dup) => {
    const dupRel = duplicateRelationsById?.[dup.id];
    const attachmentIds = dupRel?.attachmentIds ?? asStringArray(dup.attachmentIds);
    const attachments = dupRel?.attachments ?? extractAttachments(dup.attachments);
    const noteIds = dupRel?.noteIds ?? asStringArray(dup.noteIds);
    const tagIds = dupRel?.tagIds ?? asStringArray(dup.tagIds);
    const collectionIds = dupRel?.collectionIds ?? asStringArray(dup.collectionIds);
    const identifiers = dupRel?.identifiers ?? extractIdentifiers(dup.identifiers);
    const contributors = dupRel?.contributors ?? extractContributors(dup.contributors);
    const itemRelations = dupRel?.itemRelations ?? extractItemRelations(dup.itemRelations);
    const userPublications = dupRel?.userPublications ?? extractUserPublications(dup.userPublications);
    const userStates = dupRel?.userStates ?? extractUserStates(dup.userStates ?? dup.states);
    const itemMetadata = dupRel?.itemMetadata ?? extractItemMetadata(dup.itemMetadata);

    if (
      contributors !== undefined ||
      itemRelations !== undefined ||
      userPublications !== undefined ||
      userStates !== undefined ||
      itemMetadata !== undefined
    ) {
      hasV3Relations = true;
    }

    const dupAttCount =
      typeof dup.attachmentCount === 'number'
        ? dup.attachmentCount
        : attachmentIds !== undefined
          ? attachmentIds.length
          : attachments !== undefined
            ? attachments.length
            : undefined;
    const dupHasFile =
      typeof dup.hasFile === 'boolean'
        ? dup.hasFile
        : dupAttCount !== undefined
          ? dupAttCount > 0
          : undefined;

    return {
      id: dup.id,
      ...(typeof dup.title === 'string' ? { title: dup.title } : {}),
      ...(dup.citationKey !== undefined ? { citationKey: dup.citationKey as string | null } : {}),
      ...(dup.doi !== undefined ? { doi: dup.doi as string | null } : {}),
      ...(dupHasFile !== undefined ? { hasFile: dupHasFile } : {}),
      ...(dupAttCount !== undefined ? { attachmentCount: dupAttCount } : {}),
      metadata: { ...asPlainObject(dup.metadata) },
      ...(attachmentIds !== undefined ? { attachmentIds: [...attachmentIds] } : {}),
      ...(attachments !== undefined ? { attachments: [...attachments] } : {}),
      ...(noteIds !== undefined ? { noteIds: [...noteIds] } : {}),
      ...(tagIds !== undefined ? { tagIds: [...tagIds] } : {}),
      ...(collectionIds !== undefined ? { collectionIds: [...collectionIds] } : {}),
      ...(identifiers !== undefined ? { identifiers: [...identifiers] } : {}),
      ...(contributors !== undefined ? { contributors: [...contributors] } : {}),
      ...(itemRelations !== undefined ? { itemRelations: [...itemRelations] } : {}),
      ...(userPublications !== undefined ? { userPublications: [...userPublications] } : {}),
      ...(userStates !== undefined ? { userStates: [...userStates] } : {}),
      ...(itemMetadata !== undefined ? { itemMetadata: [...itemMetadata] } : {}),
    };
  });

  return {
    schemaVersion: params.schemaVersion ?? (hasV3Relations ? 3 : 2),
    masterItemId: primary.id,
    mergedDuplicateIds: [...uniqueDupIds],
    mergedAt: now.toISOString(),
    beforeMaster,
    mergedDuplicates,
    reassignedAssetIds: {
      noteIds: [...reassignedNoteIds],
      attachmentIds: [...reassignedAttachmentIds],
    },
    mergedMetadataFields: [...mergedMetadataFields],
    mergedCreatorCount,
  };
}

export function serializeMergeMemento(snapshot: DuplicateMergeMemento): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue;
}

export function parseMergeMemento(rawSnapshot: unknown): DuplicateMergeMemento | null {
  if (!rawSnapshot) return null;
  let parsed: unknown = rawSnapshot;
  if (typeof rawSnapshot === 'string') {
    try {
      parsed = JSON.parse(rawSnapshot);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const rec = parsed as Record<string, unknown>;
  const masterItemId =
    typeof rec.masterItemId === 'string' && rec.masterItemId.trim()
      ? rec.masterItemId.trim()
      : typeof (rec.beforeMaster as Record<string, unknown> | undefined)?.id === 'string'
        ? String((rec.beforeMaster as Record<string, unknown>).id).trim()
        : '';

  const rawDupIds = Array.isArray(rec.mergedDuplicateIds)
    ? rec.mergedDuplicateIds
    : Array.isArray(rec.duplicateItemIds)
      ? rec.duplicateItemIds
      : Array.isArray(rec.mergedDuplicates)
        ? (rec.mergedDuplicates as Array<Record<string, unknown>>).map((d) => d?.id)
        : [];

  const mergedDuplicateIds = rawDupIds
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());

  if (!masterItemId && mergedDuplicateIds.length === 0) return null;

  const beforeMasterRaw = asPlainObject(rec.beforeMaster);
  const beforeMaster: MasterItemSnapshot | undefined =
    Object.keys(beforeMasterRaw).length > 0
      ? {
          id: typeof beforeMasterRaw.id === 'string' ? beforeMasterRaw.id : masterItemId,
          ...beforeMasterRaw,
          ...(beforeMasterRaw.metadata && typeof beforeMasterRaw.metadata === 'object'
            ? { metadata: { ...asPlainObject(beforeMasterRaw.metadata) } }
            : {}),
          ...(asStringArray(beforeMasterRaw.attachmentIds) !== undefined ? { attachmentIds: asStringArray(beforeMasterRaw.attachmentIds) } : {}),
          ...(extractAttachments(beforeMasterRaw.attachments) !== undefined ? { attachments: extractAttachments(beforeMasterRaw.attachments) } : {}),
          ...(asStringArray(beforeMasterRaw.tagIds) !== undefined ? { tagIds: asStringArray(beforeMasterRaw.tagIds) } : {}),
          ...(asStringArray(beforeMasterRaw.collectionIds) !== undefined ? { collectionIds: asStringArray(beforeMasterRaw.collectionIds) } : {}),
          ...(extractContributors(beforeMasterRaw.contributors) !== undefined ? { contributors: extractContributors(beforeMasterRaw.contributors) } : {}),
          ...(extractIdentifiers(beforeMasterRaw.identifiers) !== undefined ? { identifiers: extractIdentifiers(beforeMasterRaw.identifiers) } : {}),
          ...(extractItemRelations(beforeMasterRaw.itemRelations) !== undefined ? { itemRelations: extractItemRelations(beforeMasterRaw.itemRelations) } : {}),
          ...(extractUserPublications(beforeMasterRaw.userPublications) !== undefined ? { userPublications: extractUserPublications(beforeMasterRaw.userPublications) } : {}),
          ...(extractUserStates(beforeMasterRaw.userStates) !== undefined ? { userStates: extractUserStates(beforeMasterRaw.userStates) } : {}),
          ...(extractItemMetadata(beforeMasterRaw.itemMetadata) !== undefined ? { itemMetadata: extractItemMetadata(beforeMasterRaw.itemMetadata) } : {}),
        }
      : undefined;

  const mergedDuplicates: MergedDuplicateSnapshot[] | undefined = Array.isArray(rec.mergedDuplicates)
    ? (rec.mergedDuplicates as Array<Record<string, unknown>>)
        .filter((d) => d && typeof d.id === 'string')
        .map((d) => {
          const attachmentIds = asStringArray(d.attachmentIds);
          const attachments = extractAttachments(d.attachments);
          const noteIds = asStringArray(d.noteIds);
          const tagIds = asStringArray(d.tagIds);
          const collectionIds = asStringArray(d.collectionIds);
          const identifiers = extractIdentifiers(d.identifiers);
          const contributors = extractContributors(d.contributors);
          const itemRelations = extractItemRelations(d.itemRelations);
          const userPublications = extractUserPublications(d.userPublications);
          const userStates = extractUserStates(d.userStates);
          const itemMetadata = extractItemMetadata(d.itemMetadata);
          return {
            id: String(d.id),
            ...(typeof d.title === 'string' ? { title: d.title } : {}),
            ...(d.citationKey !== undefined ? { citationKey: d.citationKey as string | null } : {}),
            ...(d.doi !== undefined ? { doi: d.doi as string | null } : {}),
            ...(typeof d.hasFile === 'boolean' ? { hasFile: d.hasFile } : {}),
            ...(typeof d.attachmentCount === 'number' ? { attachmentCount: d.attachmentCount } : {}),
            ...(d.metadata && typeof d.metadata === 'object' ? { metadata: { ...asPlainObject(d.metadata) } } : {}),
            ...(attachmentIds !== undefined ? { attachmentIds } : {}),
            ...(attachments !== undefined ? { attachments } : {}),
            ...(noteIds !== undefined ? { noteIds } : {}),
            ...(tagIds !== undefined ? { tagIds } : {}),
            ...(collectionIds !== undefined ? { collectionIds } : {}),
            ...(identifiers !== undefined ? { identifiers } : {}),
            ...(contributors !== undefined ? { contributors } : {}),
            ...(itemRelations !== undefined ? { itemRelations } : {}),
            ...(userPublications !== undefined ? { userPublications } : {}),
            ...(userStates !== undefined ? { userStates } : {}),
            ...(itemMetadata !== undefined ? { itemMetadata } : {}),
          };
        })
    : undefined;

  return {
    schemaVersion: rec.schemaVersion === 1 ? 1 : rec.schemaVersion === 3 ? 3 : 2,
    masterItemId,
    mergedDuplicateIds,
    mergedAt:
      typeof rec.mergedAt === 'string'
        ? rec.mergedAt
        : typeof rec.timestamp === 'string'
          ? rec.timestamp
          : new Date().toISOString(),
    beforeMaster,
    mergedDuplicates,
    reassignedAssetIds:
      rec.reassignedAssetIds && typeof rec.reassignedAssetIds === 'object'
        ? (rec.reassignedAssetIds as DuplicateMergeMemento['reassignedAssetIds'])
        : undefined,
    mergedMetadataFields: Array.isArray(rec.mergedMetadataFields)
      ? (rec.mergedMetadataFields as string[])
      : Array.isArray(rec.backfilledFields)
        ? (rec.backfilledFields as string[])
        : undefined,
    mergedCreatorCount: typeof rec.mergedCreatorCount === 'number' ? rec.mergedCreatorCount : undefined,
  };
}

export function buildMasterRestoreData(
  memento: DuplicateMergeMemento,
  currentMasterMetadata?: unknown,
): { scalarData: Record<string, unknown>; restoredMetadata: Record<string, unknown> } {
  const scalarData: Record<string, unknown> = {};
  const currentMeta = { ...asPlainObject(currentMasterMetadata) };

  if (memento.beforeMaster) {
    for (const [key, val] of Object.entries(memento.beforeMaster)) {
      if (RESTORABLE_MASTER_SCALAR_KEYS.has(key) && val !== undefined) {
        scalarData[key] = val;
      }
    }
    if (memento.beforeMaster.metadata && typeof memento.beforeMaster.metadata === 'object') {
      const restoredMetadata = { ...memento.beforeMaster.metadata };
      delete restoredMetadata.lastMergeMemento;
      return { scalarData, restoredMetadata };
    }
  }

  if (Array.isArray(currentMeta.mergeHistory)) {
    const history = currentMeta.mergeHistory as Array<Record<string, unknown>>;
    currentMeta.mergeHistory = history.filter((entry) => entry?.mergedAt !== memento.mergedAt);
  }
  if (Array.isArray(memento.mergedMetadataFields)) {
    for (const backfilledKey of memento.mergedMetadataFields) {
      if (!RESTORABLE_MASTER_SCALAR_KEYS.has(backfilledKey)) {
        delete currentMeta[backfilledKey];
      }
    }
  }
  delete currentMeta.lastMergeMemento;
  return { scalarData, restoredMetadata: currentMeta };
}

export async function recordMergeMementoInTx(params: {
  tx: Prisma.TransactionClient;
  userId: string;
  projectId?: string;
  primaryId: string;
  primaryMeta: Record<string, unknown>;
  memento: DuplicateMergeMemento;
}): Promise<void> {
  const { tx, userId, projectId, primaryId, primaryMeta, memento } = params;
  const serialized = serializeMergeMemento(memento);
  primaryMeta.lastMergeMemento = serialized;

  const dynamicTx = tx as unknown as {
    duplicateMergeAudit?: {
      create?: (args: { data: Record<string, unknown> }) => Promise<unknown>;
    };
  };
  if (typeof dynamicTx.duplicateMergeAudit?.create === 'function') {
    await dynamicTx.duplicateMergeAudit.create({
      data: {
        userId,
        projectId: projectId ?? null,
        masterItemId: primaryId,
        snapshotJson: serialized,
      },
    });
  }
}

export async function executeUndoDuplicateMergeInTx(params: {
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  userId: string;
  primaryItemId: string;
  effectiveProjectId?: string;
}): Promise<{ restoredPrimaryId: string; restoredDuplicateIds: string[] }> {
  const { tx, helpers, userId, primaryItemId, effectiveProjectId } = params;
  const dynamicTx = tx as unknown as {
    duplicateMergeAudit?: {
      findFirst?: (args: {
        where: Record<string, unknown>;
        orderBy?: Record<string, 'asc' | 'desc'>;
      }) => Promise<{ id?: string; masterItemId?: string; snapshotJson?: unknown; mementoSnapshot?: unknown } | null>;
      delete?: (args: { where: { id: string } }) => Promise<unknown>;
    };
  };

  const auditWhere = {
    masterItemId: primaryItemId,
    userId,
    ...(effectiveProjectId ? { projectId: effectiveProjectId } : {}),
  };

  const rawAuditRecord =
    typeof dynamicTx.duplicateMergeAudit?.findFirst === 'function'
      ? await dynamicTx.duplicateMergeAudit.findFirst({
          where: auditWhere,
          orderBy: { createdAt: 'desc' },
        })
      : null;

  const masterItem = await tx.item?.findUnique?.({ where: { id: primaryItemId } });
  const masterMeta = asPlainObject(masterItem?.metadata);
  const rawAuditPayload = rawAuditRecord?.snapshotJson ?? rawAuditRecord?.mementoSnapshot;
  const memento =
    parseMergeMemento(rawAuditPayload) ??
    parseMergeMemento(masterMeta.lastMergeMemento);

  if (!memento) {
    throw new NotFoundException(`No reversible merge memento found for item ${primaryItemId}`);
  }

  // Pop the consumed audit record from the audit stack
  if (rawAuditRecord?.id && typeof dynamicTx.duplicateMergeAudit?.delete === 'function') {
    await dynamicTx.duplicateMergeAudit.delete({ where: { id: rawAuditRecord.id } });
  }

  const restoredMasterId = memento.masterItemId || primaryItemId;
  const duplicateSnapshots = memento.mergedDuplicates ?? [];
  const duplicateIdsToRestore = Array.from(
    new Set([...memento.mergedDuplicateIds, ...duplicateSnapshots.map((d) => d.id)]),
  );

  const eventScope = { userId, projectId: effectiveProjectId };
  const { scalarData, restoredMetadata } = buildMasterRestoreData(memento, masterItem?.metadata);

  // If a prior merge audit record remains on the stack, restore it as lastMergeMemento
  if (rawAuditRecord?.id && typeof dynamicTx.duplicateMergeAudit?.findFirst === 'function') {
    const prevAuditRecord = await dynamicTx.duplicateMergeAudit.findFirst({
      where: auditWhere,
      orderBy: { createdAt: 'desc' },
    });
    const prevSnapshot = prevAuditRecord?.snapshotJson ?? prevAuditRecord?.mementoSnapshot;
    if (prevAuditRecord && prevAuditRecord.id !== rawAuditRecord.id && prevSnapshot !== undefined) {
      restoredMetadata.lastMergeMemento = prevSnapshot;
    }
  }

  const updatedMaster = await tx.item.update({
    where: { id: restoredMasterId },
    data: { ...scalarData, metadata: restoredMetadata as Prisma.InputJsonValue, version: { increment: 1 } },
  });

  await restoreMasterRelationsInTx(tx, restoredMasterId, memento.beforeMaster);

  const enrichedMaster = updatedMaster
    ? {
        ...updatedMaster,
        ...(memento.beforeMaster?.contributors !== undefined
          ? { contributors: memento.beforeMaster.contributors }
          : {}),
        ...(memento.beforeMaster?.identifiers !== undefined
          ? { identifiers: memento.beforeMaster.identifiers }
          : {}),
      }
    : { id: restoredMasterId };

  await helpers.appendChange(eventScope, {
    entityType: 'Item',
    entityId: restoredMasterId,
    action: 'update',
    version: updatedMaster?.version ?? 1,
    data: ItemsMapper.toDomain(enrichedMaster),
  });
  await helpers.publishOutbox(eventScope, restoredMasterId, LIBRARY_EVENT_TYPES.ITEM_UPDATED, {
    itemId: restoredMasterId,
    userId,
    projectId: effectiveProjectId,
    unmergedDuplicateIds: duplicateIdsToRestore,
  });

  const snapshotByDupId = new Map(duplicateSnapshots.map((snap) => [snap.id, snap]));

  const restoredDupItems = await Promise.all(
    duplicateIdsToRestore.map(async (dupId) => {
      const snap = snapshotByDupId.get(dupId);
      const dupRestoreMeta: Record<string, unknown> = { ...(snap?.metadata ?? {}) };
      delete dupRestoreMeta.mergedIntoId;
      delete dupRestoreMeta.mergedAt;

      const restoredAttCount =
        typeof snap?.attachmentCount === 'number'
          ? snap.attachmentCount
          : Array.isArray(snap?.attachmentIds)
            ? snap.attachmentIds.length
            : Array.isArray(snap?.attachments)
              ? snap.attachments.length
              : undefined;
      const restoredHasFile =
        typeof snap?.hasFile === 'boolean'
          ? snap.hasFile
          : restoredAttCount !== undefined
            ? restoredAttCount > 0
            : undefined;

      const restoredDup = await tx.item.update({
        where: { id: dupId },
        data: {
          deletedAt: null,
          ...(snap?.title !== undefined ? { title: snap.title } : {}),
          ...(snap?.citationKey !== undefined ? { citationKey: snap.citationKey } : {}),
          ...(snap?.doi !== undefined ? { doi: snap.doi } : {}),
          ...(restoredHasFile !== undefined ? { hasFile: restoredHasFile } : {}),
          ...(restoredAttCount !== undefined ? { attachmentCount: restoredAttCount } : {}),
          ...(Object.keys(dupRestoreMeta).length > 0 ? { metadata: dupRestoreMeta as Prisma.InputJsonValue } : {}),
          version: { increment: 1 },
        },
      });

      await restoreDuplicateRelationsInTx(
        tx,
        restoredMasterId,
        dupId,
        snap,
        duplicateIdsToRestore.length === 1 ? memento.reassignedAssetIds : undefined,
      );

      return { dupId, snap, restoredDup };
    }),
  );

  if (duplicateIdsToRestore.length > 0) {
    if (helpers.removeTombstonesBatch) {
      await helpers.removeTombstonesBatch(eventScope, 'Item', duplicateIdsToRestore);
    } else {
      for (const dupId of duplicateIdsToRestore) {
        await helpers.removeTombstone?.(eventScope, 'Item', dupId);
      }
    }

    const restoredAttachmentIds = new Set<string>();
    const restoredNoteIds = new Set<string>();
    for (const { snap } of restoredDupItems) {
      if (Array.isArray(snap?.attachmentIds)) {
        snap.attachmentIds.forEach((id) => {
          if (typeof id === 'string' && id) restoredAttachmentIds.add(id);
        });
      }
      if (Array.isArray(snap?.attachments)) {
        snap.attachments.forEach((a) => {
          if (typeof a?.id === 'string' && a.id) restoredAttachmentIds.add(a.id);
        });
      }
      if (Array.isArray(snap?.noteIds)) {
        snap.noteIds.forEach((id) => {
          if (typeof id === 'string' && id) restoredNoteIds.add(id);
        });
      }
      if (Array.isArray(snap?.notesList)) {
        snap.notesList.forEach((n) => {
          if (typeof n?.id === 'string' && n.id) restoredNoteIds.add(n.id);
        });
      }
    }
    if (duplicateIdsToRestore.length === 1 && memento.reassignedAssetIds) {
      memento.reassignedAssetIds.attachmentIds?.forEach((id) => {
        if (typeof id === 'string' && id) restoredAttachmentIds.add(id);
      });
      memento.reassignedAssetIds.noteIds?.forEach((id) => {
        if (typeof id === 'string' && id) restoredNoteIds.add(id);
      });
    }

    if (restoredAttachmentIds.size > 0) {
      const attIds = Array.from(restoredAttachmentIds);
      if (helpers.removeTombstonesBatch) {
        await helpers.removeTombstonesBatch(eventScope, 'Attachment', attIds);
      } else {
        for (const attId of attIds) {
          await helpers.removeTombstone?.(eventScope, 'Attachment', attId);
        }
      }
    }

    if (restoredNoteIds.size > 0) {
      const noteIds = Array.from(restoredNoteIds);
      if (helpers.removeTombstonesBatch) {
        await helpers.removeTombstonesBatch(eventScope, 'Note', noteIds);
      } else {
        for (const noteId of noteIds) {
          await helpers.removeTombstone?.(eventScope, 'Note', noteId);
        }
      }
    }

    const changeEntries = restoredDupItems.map(({ dupId, snap, restoredDup }) => {
      const enrichedDup = restoredDup
        ? {
            ...restoredDup,
            ...(snap?.contributors !== undefined
              ? { contributors: snap.contributors }
              : {}),
            ...(snap?.identifiers !== undefined
              ? { identifiers: snap.identifiers }
              : {}),
          }
        : { id: dupId };
      return {
        entityType: 'Item' as const,
        entityId: dupId,
        action: 'create' as const,
        version: restoredDup?.version ?? 1,
        data: ItemsMapper.toDomain(enrichedDup),
      };
    });

    const outboxEvents = restoredDupItems.map(({ dupId }) => ({
      aggregateId: dupId,
      eventType: LIBRARY_EVENT_TYPES.ITEM_RESTORED,
      payload: {
        itemId: dupId,
        restoredFromMasterId: restoredMasterId,
        userId,
        projectId: effectiveProjectId,
      },
    }));

    if (helpers.appendChangesBatch) {
      await helpers.appendChangesBatch(eventScope, changeEntries);
    } else {
      for (const entry of changeEntries) {
        await helpers.appendChange(eventScope, entry);
      }
    }

    if (helpers.publishOutboxBatch) {
      await helpers.publishOutboxBatch(eventScope, outboxEvents);
    } else {
      for (const ev of outboxEvents) {
        await helpers.publishOutbox(
          eventScope,
          ev.aggregateId,
          ev.eventType,
          ev.payload,
        );
      }
    }
  }

  return { restoredPrimaryId: restoredMasterId, restoredDuplicateIds: duplicateIdsToRestore };
}
