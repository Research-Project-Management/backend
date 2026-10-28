import { Prisma } from '@prisma/client';
import {
  TransactionHelpers,
  LIBRARY_EVENT_TYPES,
} from '@/modules/library/core';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { ItemsMapper } from './items.mapper';

export async function executeBulkSoftDeleteInTx(params: {
  command: CommandRepository;
  userId: string;
  itemIds: string[];
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  validProjectId?: string;
}) {
  const { command, userId, itemIds, tx, helpers, validProjectId } = params;
  const res = await command.softDeleteMany(userId, itemIds, tx, validProjectId);
  if (res.succeededIds.length > 0) {
    const eventScope = { userId, projectId: validProjectId };
    const deletedAt = new Date();
    const deletedIso = deletedAt.toISOString();
    await helpers.recordTombstonesBatch(
      eventScope,
      res.succeededIds.map((id) => ({
        entityType: 'Item',
        entityId: id,
      })),
    );
    await helpers.appendChangesBatch(
      eventScope,
      res.succeededIds.map((id) => ({
        entityType: 'Item',
        entityId: id,
        action: 'delete',
        version: 0,
        data: { id, deletedAt: deletedIso },
      })),
    );
    await helpers.publishOutboxBatch(
      eventScope,
      res.succeededIds.map((id) => ({
        aggregateId: id,
        eventType: LIBRARY_EVENT_TYPES.ITEM_DELETED,
        payload: { id, deletedAt, projectId: validProjectId },
      })),
    );
  }
  return res;
}

export async function executeBulkRestoreInTx(params: {
  command: CommandRepository;
  query: QueryRepository;
  userId: string;
  itemIds: string[];
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  validProjectId?: string;
}) {
  const { command, query, userId, itemIds, tx, helpers, validProjectId } =
    params;
  const res = await command.restoreMany(userId, itemIds, tx, validProjectId);
  if (res.restoredItems.length > 0) {
    const restoredFullItems = await query.findByIds(
      userId,
      res.succeededIds,
      validProjectId,
      tx,
      false,
    );
    const fullItemMap = new Map(
      (restoredFullItems || []).map((it) => [it.id, it]),
    );
    const restoredAt = new Date().toISOString();
    const changeInputs = res.restoredItems.map((restored) => {
      const effectiveProjectId =
        validProjectId || restored.projectId || undefined;
      const fullItem = fullItemMap.get(restored.id);
      return {
        userId,
        projectId: effectiveProjectId,
        entityType: 'Item',
        entityId: restored.id,
        action: 'update' as const,
        version: restored.version,
        data: fullItem
          ? ItemsMapper.toDomain(fullItem)
          : {
              id: restored.id,
              version: restored.version,
              projectId: effectiveProjectId,
            },
      };
    });
    await helpers.appendChangesBatch(changeInputs);
    await helpers.removeTombstonesBatch(
      { userId, projectId: validProjectId },
      'Item',
      res.restoredItems.map((r) => r.id),
    );
    const outboxInputs = res.restoredItems.map((restored) => {
      const effectiveProjectId =
        validProjectId || restored.projectId || undefined;
      return {
        userId,
        projectId: effectiveProjectId,
        aggregateId: restored.id,
        eventType: LIBRARY_EVENT_TYPES.ITEM_RESTORED,
        payload: {
          itemId: restored.id,
          userId,
          projectId: effectiveProjectId,
          restoredAt,
        },
      };
    });
    await helpers.publishOutboxBatch(outboxInputs);
  }
  return res;
}

export async function executeBulkPurgeInTx(params: {
  command: CommandRepository;
  userId: string;
  itemIds: string[];
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
  validProjectId?: string;
}) {
  const { command, userId, itemIds, tx, helpers, validProjectId } = params;
  const res = await command.purgeMany(userId, itemIds, tx, validProjectId);
  if (res.succeededIds.length > 0) {
    const eventScope = { userId, projectId: validProjectId };
    const purgedAt = new Date().toISOString();
    await helpers.recordTombstonesBatch(
      eventScope,
      res.succeededIds.map((id) => ({ entityType: 'Item', entityId: id })),
    );
    await helpers.appendChangesBatch(
      eventScope,
      res.succeededIds.map((id) => ({
        entityType: 'Item',
        entityId: id,
        action: 'delete',
        version: 0,
      })),
    );
    await helpers.publishOutboxBatch(
      eventScope,
      res.succeededIds.map((id, idx) => ({
        aggregateId: id,
        eventType: LIBRARY_EVENT_TYPES.ITEM_PURGED,
        payload: {
          itemId: id,
          itemIds: res.succeededIds,
          userId,
          projectId: validProjectId,
          filePaths: idx === 0 ? res.storagePaths : [],
          purgedAt,
        },
      })),
    );
  }
  return res;
}

export async function executePurgeExpiredTrashInTx(params: {
  command: CommandRepository;
  retentionDays: number;
  limit: number;
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
}) {
  const { command, retentionDays, limit, tx, helpers } = params;
  const res = await command.purgeExpiredTrash(retentionDays, limit, tx);
  const expiredItems = res.expiredItems ?? [];
  const expiredNotes = res.expiredNotes ?? [];
  const expiredCollections = res.expiredCollections ?? [];

  const tombstoneInputs = [
    ...expiredItems.map((it) => ({
      userId: it.userId,
      projectId: it.projectId ?? undefined,
      entityType: 'Item',
      entityId: it.id,
    })),
    ...expiredNotes.map((n) => ({
      userId: n.userId,
      projectId: n.projectId ?? undefined,
      entityType: 'Note',
      entityId: n.id,
    })),
    ...expiredCollections.map((c) => ({
      userId: c.userId,
      projectId: c.projectId ?? undefined,
      entityType: 'Collection',
      entityId: c.id,
    })),
  ];

  if (tombstoneInputs.length > 0) {
    await helpers.recordTombstonesBatch(tombstoneInputs);
    await helpers.appendChangesBatch(
      tombstoneInputs.map((entry) => ({
        userId: entry.userId,
        projectId: entry.projectId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: 'delete' as const,
        version: 0,
      })),
    );
  }

  if (expiredItems.length > 0) {
    const purgedAt = new Date().toISOString();
    const allExpiredItemIds = expiredItems.map((it) => it.id);
    await helpers.publishOutboxBatch(
      expiredItems.map((it, idx) => ({
        userId: it.userId,
        projectId: it.projectId ?? undefined,
        aggregateId: it.id,
        eventType: LIBRARY_EVENT_TYPES.ITEM_PURGED,
        payload: {
          itemId: it.id,
          itemIds: allExpiredItemIds,
          userId: it.userId,
          projectId: it.projectId ?? undefined,
          filePaths: idx === 0 ? res.storagePaths : [],
          purgedAt,
        },
      })),
    );
  }
  return res;
}
