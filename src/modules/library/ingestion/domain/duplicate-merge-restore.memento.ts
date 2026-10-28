import { AttachmentType, Prisma, RelationType } from '@prisma/client';
import type {
  MasterItemSnapshot,
  MergedDuplicateSnapshot,
} from './duplicate-merge-relations.memento';

export async function syncRestoredItemCountsInTx(
  tx: Prisma.TransactionClient,
  itemId: string,
): Promise<{ hasFile?: boolean; attachmentCount?: number; noteCount?: number }> {
  const hasAttCount = typeof tx.attachment?.count === 'function';
  const hasNoteCount = typeof tx.note?.count === 'function';
  if (!hasAttCount && !hasNoteCount) return {};

  const countData: {
    hasFile?: boolean;
    attachmentCount?: number;
    noteCount?: number;
  } = {};
  if (hasAttCount) {
    const liveAttCount = await tx.attachment.count({
      where: { itemId, deletedAt: null },
    });
    countData.hasFile = liveAttCount > 0;
    countData.attachmentCount = liveAttCount;
  }
  if (hasNoteCount) {
    const liveNoteCount = await tx.note.count({
      where: { itemId, deletedAt: null },
    });
    countData.noteCount = liveNoteCount;
  }
  if (typeof tx.item?.updateMany === 'function') {
    await tx.item.updateMany({
      where: { id: itemId },
      data: countData,
    });
  } else if (typeof tx.item?.update === 'function') {
    await tx.item.update({
      where: { id: itemId },
      data: countData,
    });
  }
  return countData;
}

export async function restoreMasterRelationsInTx(
  tx: Prisma.TransactionClient,
  restoredMasterId: string,
  beforeMaster?: MasterItemSnapshot,
  options?: { skipCountRecalc?: boolean },
): Promise<void> {
  if (!beforeMaster) return;

  if (Array.isArray(beforeMaster.tagIds)) {
    if (typeof tx.itemTag?.deleteMany === 'function') {
      await tx.itemTag.deleteMany({
        where: {
          itemId: restoredMasterId,
          ...(beforeMaster.tagIds.length > 0
            ? { tagId: { notIn: beforeMaster.tagIds } }
            : {}),
        },
      });
    }
    if (
      beforeMaster.tagIds.length > 0 &&
      typeof tx.itemTag?.createMany === 'function'
    ) {
      await tx.itemTag.createMany({
        data: beforeMaster.tagIds.map((tagId) => ({
          itemId: restoredMasterId,
          tagId,
        })),
        skipDuplicates: true,
      });
    }
  }

  if (Array.isArray(beforeMaster.collectionIds)) {
    if (typeof tx.collectionItem?.deleteMany === 'function') {
      await tx.collectionItem.deleteMany({
        where: {
          itemId: restoredMasterId,
          ...(beforeMaster.collectionIds.length > 0
            ? { collectionId: { notIn: beforeMaster.collectionIds } }
            : {}),
        },
      });
    }
    if (
      beforeMaster.collectionIds.length > 0 &&
      typeof tx.collectionItem?.createMany === 'function'
    ) {
      await tx.collectionItem.createMany({
        data: beforeMaster.collectionIds.map((collectionId) => ({
          itemId: restoredMasterId,
          collectionId,
        })),
        skipDuplicates: true,
      });
    }
  }

  if (
    Array.isArray(beforeMaster.contributors) &&
    typeof tx.contributor?.deleteMany === 'function' &&
    typeof tx.contributor?.createMany === 'function'
  ) {
    await tx.contributor.deleteMany({ where: { itemId: restoredMasterId } });
    if (beforeMaster.contributors.length > 0) {
      await tx.contributor.createMany({
        data: beforeMaster.contributors.map((c, idx) => ({
          itemId: restoredMasterId,
          creatorType: c.creatorType || 'author',
          fieldMode: c.fieldMode ?? 0,
          firstName: c.firstName ?? '',
          lastName: c.lastName ?? '',
          fullName: c.fullName ?? '',
          shortName: c.shortName ?? '',
          orderIndex: c.orderIndex ?? idx,
        })),
      });
    }
  }

  if (Array.isArray(beforeMaster.identifiers)) {
    if (typeof tx.itemIdentifier?.deleteMany === 'function') {
      await tx.itemIdentifier.deleteMany({
        where: {
          itemId: restoredMasterId,
          ...(beforeMaster.identifiers.length > 0
            ? { type: { notIn: beforeMaster.identifiers.map((i) => i.type) } }
            : {}),
        },
      });
    }
    if (typeof tx.itemIdentifier?.upsert === 'function') {
      for (const ident of beforeMaster.identifiers) {
        const canonicalUri = ident.canonicalUri ?? ident.value;
        await tx.itemIdentifier.upsert({
          where: { itemId_type: { itemId: restoredMasterId, type: ident.type } },
          update: { value: ident.value, canonicalUri },
          create: {
            itemId: restoredMasterId,
            type: ident.type,
            value: ident.value,
            canonicalUri,
          },
        });
      }
    }
  }

  if (Array.isArray(beforeMaster.itemRelations)) {
    if (typeof tx.itemRelation?.deleteMany === 'function') {
      await tx.itemRelation.deleteMany({
        where: {
          OR: [
            { sourceItemId: restoredMasterId },
            { targetItemId: restoredMasterId },
          ],
        },
      });
    }
    if (
      beforeMaster.itemRelations.length > 0 &&
      typeof tx.itemRelation?.createMany === 'function'
    ) {
      await tx.itemRelation.createMany({
        data: beforeMaster.itemRelations.map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          sourceItemId: r.sourceItemId,
          targetItemId: r.targetItemId,
          relationType: (r.relationType || 'related') as RelationType,
          ...(r.description !== undefined ? { description: r.description } : {}),
        })),
        skipDuplicates: true,
      });
    }
  }

  if (Array.isArray(beforeMaster.userPublications)) {
    if (typeof tx.userPublication?.deleteMany === 'function') {
      await tx.userPublication.deleteMany({ where: { itemId: restoredMasterId } });
    }
    if (
      beforeMaster.userPublications.length > 0 &&
      typeof tx.userPublication?.createMany === 'function'
    ) {
      await tx.userPublication.createMany({
        data: beforeMaster.userPublications.map((p) => ({
          userId: p.userId,
          itemId: restoredMasterId,
          contributorId: p.contributorId ?? null,
          isPublic: p.isPublic ?? false,
          openAccessLicense: p.openAccessLicense ?? null,
          ...(p.addedAt ? { addedAt: new Date(p.addedAt) } : {}),
        })),
        skipDuplicates: true,
      });
    }
  }

  if (Array.isArray(beforeMaster.userStates)) {
    if (typeof tx.state?.deleteMany === 'function') {
      await tx.state.deleteMany({ where: { itemId: restoredMasterId } });
    }
    if (
      beforeMaster.userStates.length > 0 &&
      typeof tx.state?.createMany === 'function'
    ) {
      await tx.state.createMany({
        data: beforeMaster.userStates.map((s) => ({
          userId: s.userId,
          itemId: restoredMasterId,
          isStarred: s.isStarred ?? false,
          rating: s.rating ?? null,
          readStatus: s.readStatus ?? 'unread',
          currentPage: s.currentPage ?? null,
          ...(s.scrollPosition !== undefined
            ? { scrollPosition: s.scrollPosition as Prisma.InputJsonValue }
            : {}),
          ...(s.lastOpenedAt !== undefined
            ? { lastOpenedAt: s.lastOpenedAt ? new Date(s.lastOpenedAt) : null }
            : {}),
          ...(s.lastReadAt !== undefined
            ? { lastReadAt: s.lastReadAt ? new Date(s.lastReadAt) : null }
            : {}),
        })),
        skipDuplicates: true,
      });
    }
  }

  if (Array.isArray(beforeMaster.itemMetadata)) {
    if (typeof tx.itemMetadata?.deleteMany === 'function') {
      await tx.itemMetadata.deleteMany({ where: { itemId: restoredMasterId } });
    }
    if (
      beforeMaster.itemMetadata.length > 0 &&
      typeof tx.itemMetadata?.createMany === 'function'
    ) {
      await tx.itemMetadata.createMany({
        data: beforeMaster.itemMetadata.map((m) => ({
          ...(m.id ? { id: m.id } : {}),
          itemId: restoredMasterId,
          sourceProvider: m.sourceProvider ?? 'unknown',
          rawPayload: (m.rawPayload ?? {}) as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });
    }
  }

  if (Array.isArray(beforeMaster.attachments) && beforeMaster.attachments.length > 0) {
    if (typeof tx.attachment?.update === 'function') {
      for (const att of beforeMaster.attachments) {
        if (att.id && typeof att.attachmentType === 'string' && att.attachmentType.length > 0) {
          await tx.attachment.update({
            where: { id: att.id },
            data: { attachmentType: att.attachmentType as AttachmentType },
          });
        }
      }
    }
  }

  const masterAnnots = [
    ...(Array.isArray(beforeMaster.annotations) ? beforeMaster.annotations : []),
    ...(Array.isArray(beforeMaster.attachments)
      ? beforeMaster.attachments.flatMap((a) =>
          Array.isArray(a.annotations) ? a.annotations : [],
        )
      : []),
  ];
  if (masterAnnots.length > 0) {
    const seenIds = new Set<string>();
    for (const ann of masterAnnots) {
      if (!ann?.id || !ann?.attachmentId || seenIds.has(ann.id)) continue;
      seenIds.add(ann.id);
      const restoreData = {
        attachmentId: ann.attachmentId,
        deletedAt: ann.deletedAt ? new Date(ann.deletedAt) : null,
      };
      if (typeof tx.annotation?.updateMany === 'function') {
        await tx.annotation.updateMany({
          where: { id: ann.id },
          data: restoreData,
        });
      } else if (typeof tx.annotation?.update === 'function') {
        try {
          await tx.annotation.update({
            where: { id: ann.id },
            data: restoreData,
          });
        } catch {
          // Ignore missing annotation (e.g. P2025) during undo restoration
        }
      }
    }
  }

  if (!options?.skipCountRecalc) {
    await syncRestoredItemCountsInTx(tx, restoredMasterId);
  }
}

export async function restoreDuplicateRelationsInTx(
  tx: Prisma.TransactionClient,
  restoredMasterId: string,
  dupId: string,
  snap: MergedDuplicateSnapshot | undefined,
  fallbackAssets?: { noteIds?: string[]; attachmentIds?: string[] },
  options?: { skipCountRecalc?: boolean },
): Promise<void> {
  const attachmentIds = snap?.attachmentIds ?? fallbackAssets?.attachmentIds;
  if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
    const where = { id: { in: attachmentIds }, itemId: restoredMasterId };
    if (typeof tx.attachment?.updateMany === 'function') {
      await tx.attachment.updateMany({ where, data: { itemId: dupId } });
      await tx.attachment.updateMany({
        where: { id: { in: attachmentIds }, deletedAt: { not: null } },
        data: { itemId: dupId, deletedAt: null },
      });
    }
  }

  if (Array.isArray(snap?.attachments) && snap.attachments.length > 0) {
    for (const att of snap.attachments) {
      if (att.id && typeof att.attachmentType === 'string' && att.attachmentType.length > 0) {
        if (typeof tx.attachment?.update === 'function') {
          await tx.attachment.update({
            where: { id: att.id },
            data: {
              itemId: dupId,
              deletedAt: null,
              attachmentType: att.attachmentType as AttachmentType,
            },
          });
        } else if (typeof tx.attachment?.updateMany === 'function') {
          await tx.attachment.updateMany({
            where: { id: att.id },
            data: { attachmentType: att.attachmentType as AttachmentType },
          });
        }
      }
    }
  }

  const dupAnnots = [
    ...(Array.isArray(snap?.annotations) ? snap.annotations : []),
    ...(Array.isArray(snap?.attachments)
      ? snap.attachments.flatMap((a) =>
          Array.isArray(a.annotations) ? a.annotations : [],
        )
      : []),
  ];
  if (dupAnnots.length > 0) {
    const seenIds = new Set<string>();
    for (const ann of dupAnnots) {
      if (!ann?.id || !ann?.attachmentId || seenIds.has(ann.id)) continue;
      seenIds.add(ann.id);
      const restoreData = {
        attachmentId: ann.attachmentId,
        deletedAt: ann.deletedAt ? new Date(ann.deletedAt) : null,
      };
      if (typeof tx.annotation?.updateMany === 'function') {
        await tx.annotation.updateMany({
          where: { id: ann.id },
          data: restoreData,
        });
      } else if (typeof tx.annotation?.update === 'function') {
        try {
          await tx.annotation.update({
            where: { id: ann.id },
            data: restoreData,
          });
        } catch {
          // Ignore missing annotation (e.g. P2025) during undo restoration
        }
      }
    }
  }

  const noteIds = snap?.noteIds ?? fallbackAssets?.noteIds;
  if (
    Array.isArray(noteIds) &&
    noteIds.length > 0 &&
    typeof tx.note?.updateMany === 'function'
  ) {
    await tx.note.updateMany({
      where: { id: { in: noteIds }, itemId: restoredMasterId },
      data: { itemId: dupId },
    });
  }

  if (
    Array.isArray(snap?.tagIds) &&
    snap.tagIds.length > 0 &&
    typeof tx.itemTag?.createMany === 'function'
  ) {
    await tx.itemTag.createMany({
      data: snap.tagIds.map((tagId) => ({ itemId: dupId, tagId })),
      skipDuplicates: true,
    });
  }

  if (Array.isArray(snap?.collectionIds) && snap.collectionIds.length > 0) {
    const data = snap.collectionIds.map((collectionId) => ({
      itemId: dupId,
      collectionId,
    }));
    if (typeof tx.collectionItem?.createMany === 'function') {
      await tx.collectionItem.createMany({ data, skipDuplicates: true });
    }
  }

  if (Array.isArray(snap?.identifiers) && snap.identifiers.length > 0) {
    const data = snap.identifiers.map((ident) => ({
      itemId: dupId,
      type: ident.type,
      value: ident.value,
      canonicalUri: ident.canonicalUri ?? ident.value,
    }));
    if (typeof tx.itemIdentifier?.createMany === 'function') {
      await tx.itemIdentifier.createMany({ data, skipDuplicates: true });
    } else if (typeof tx.itemIdentifier?.upsert === 'function') {
      for (const row of data) {
        await tx.itemIdentifier.upsert({
          where: { itemId_type: { itemId: dupId, type: row.type } },
          update: { value: row.value, canonicalUri: row.canonicalUri },
          create: row,
        });
      }
    }
  }

  if (
    Array.isArray(snap?.contributors) &&
    typeof tx.contributor?.deleteMany === 'function' &&
    typeof tx.contributor?.createMany === 'function'
  ) {
    await tx.contributor.deleteMany({ where: { itemId: dupId } });
    if (snap.contributors.length > 0) {
      await tx.contributor.createMany({
        data: snap.contributors.map((c, idx) => ({
          itemId: dupId,
          creatorType: c.creatorType || 'author',
          fieldMode: c.fieldMode ?? 0,
          firstName: c.firstName ?? '',
          lastName: c.lastName ?? '',
          fullName: c.fullName ?? '',
          shortName: c.shortName ?? '',
          orderIndex: c.orderIndex ?? idx,
        })),
      });
    }
  }

  if (Array.isArray(snap?.itemRelations) && snap.itemRelations.length > 0) {
    const relIds = snap.itemRelations
      .map((r) => r.id)
      .filter((id): id is string => Boolean(id));
    if (relIds.length > 0 && typeof tx.itemRelation?.deleteMany === 'function') {
      await tx.itemRelation.deleteMany({ where: { id: { in: relIds } } });
    }
    if (typeof tx.itemRelation?.createMany === 'function') {
      await tx.itemRelation.createMany({
        data: snap.itemRelations.map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          sourceItemId: r.sourceItemId,
          targetItemId: r.targetItemId,
          relationType: (r.relationType || 'related') as RelationType,
          ...(r.description !== undefined ? { description: r.description } : {}),
        })),
        skipDuplicates: true,
      });
    }
  }

  if (
    Array.isArray(snap?.userPublications) &&
    snap.userPublications.length > 0 &&
    typeof tx.userPublication?.createMany === 'function'
  ) {
    await tx.userPublication.createMany({
      data: snap.userPublications.map((p) => ({
        userId: p.userId,
        itemId: dupId,
        contributorId: p.contributorId ?? null,
        isPublic: p.isPublic ?? false,
        openAccessLicense: p.openAccessLicense ?? null,
        ...(p.addedAt ? { addedAt: new Date(p.addedAt) } : {}),
      })),
      skipDuplicates: true,
    });
  }

  if (
    Array.isArray(snap?.userStates) &&
    snap.userStates.length > 0 &&
    typeof tx.state?.createMany === 'function'
  ) {
    await tx.state.createMany({
      data: snap.userStates.map((s) => ({
        userId: s.userId,
        itemId: dupId,
        isStarred: s.isStarred ?? false,
        rating: s.rating ?? null,
        readStatus: s.readStatus ?? 'unread',
        currentPage: s.currentPage ?? null,
        ...(s.scrollPosition !== undefined
          ? { scrollPosition: s.scrollPosition as Prisma.InputJsonValue }
          : {}),
        ...(s.lastOpenedAt !== undefined
          ? { lastOpenedAt: s.lastOpenedAt ? new Date(s.lastOpenedAt) : null }
          : {}),
        ...(s.lastReadAt !== undefined
          ? { lastReadAt: s.lastReadAt ? new Date(s.lastReadAt) : null }
          : {}),
      })),
      skipDuplicates: true,
    });
  }

  if (
    Array.isArray(snap?.itemMetadata) &&
    snap.itemMetadata.length > 0 &&
    (typeof tx.itemMetadata?.update === 'function' ||
      typeof tx.itemMetadata?.createMany === 'function')
  ) {
    const metaIds = snap.itemMetadata
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id));
    if (
      metaIds.length > 0 &&
      typeof tx.itemMetadata?.update === 'function' &&
      typeof tx.itemMetadata?.createMany !== 'function'
    ) {
      for (const mId of metaIds) {
        await tx.itemMetadata.update({
          where: { id: mId },
          data: { itemId: dupId },
        });
      }
    } else if (typeof tx.itemMetadata?.createMany === 'function') {
      if (
        metaIds.length > 0 &&
        typeof tx.itemMetadata?.deleteMany === 'function'
      ) {
        await tx.itemMetadata.deleteMany({
          where: { id: { in: metaIds }, itemId: restoredMasterId },
        });
      }
      await tx.itemMetadata.createMany({
        data: snap.itemMetadata.map((m) => ({
          ...(m.id ? { id: m.id } : {}),
          itemId: dupId,
          sourceProvider: m.sourceProvider ?? 'unknown',
          rawPayload: (m.rawPayload ?? {}) as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });
    }
  }

  if (!options?.skipCountRecalc) {
    await syncRestoredItemCountsInTx(tx, dupId);
  }
}

export async function restoreMergeRelationsInTx(params: {
  tx: Prisma.TransactionClient;
  restoredMasterId: string;
  beforeMaster?: MasterItemSnapshot;
  duplicateIdsToRestore: string[];
  snapshotByDupId: ReadonlyMap<string, MergedDuplicateSnapshot>;
  reassignedAssetIds?: { noteIds?: string[]; attachmentIds?: string[] };
  reassignedItemMetadata?: Array<{ id: string; previousItemId: string }>;
  skipMasterRestore?: boolean;
}): Promise<Map<string, { hasFile?: boolean; attachmentCount?: number; noteCount?: number }>> {
  const {
    tx,
    restoredMasterId,
    beforeMaster,
    duplicateIdsToRestore,
    snapshotByDupId,
    reassignedAssetIds,
    reassignedItemMetadata,
    skipMasterRestore,
  } = params;

  if (!skipMasterRestore) {
    await restoreMasterRelationsInTx(tx, restoredMasterId, beforeMaster, {
      skipCountRecalc: duplicateIdsToRestore.length > 0,
    });
  }

  if (
    Array.isArray(reassignedItemMetadata) &&
    reassignedItemMetadata.length > 0 &&
    typeof tx.itemMetadata?.update === 'function'
  ) {
    for (const entry of reassignedItemMetadata) {
      if (entry?.id && entry?.previousItemId) {
        try {
          await tx.itemMetadata.update({
            where: { id: entry.id },
            data: { itemId: entry.previousItemId },
          });
        } catch {
          // Ignore if already restored by restoreDuplicateRelationsInTx
        }
      }
    }
  }

  const countByItemId = new Map<
    string,
    { hasFile?: boolean; attachmentCount?: number; noteCount?: number }
  >();
  for (const dupId of duplicateIdsToRestore) {
    const snap = snapshotByDupId.get(dupId);
    await restoreDuplicateRelationsInTx(
      tx,
      restoredMasterId,
      dupId,
      snap,
      duplicateIdsToRestore.length === 1 ? reassignedAssetIds : undefined,
      { skipCountRecalc: true },
    );
    const dupCounts = await syncRestoredItemCountsInTx(tx, dupId);
    countByItemId.set(dupId, dupCounts);
  }

  if (duplicateIdsToRestore.length > 0) {
    const masterCounts = await syncRestoredItemCountsInTx(tx, restoredMasterId);
    countByItemId.set(restoredMasterId, masterCounts);
  }

  return countByItemId;
}
