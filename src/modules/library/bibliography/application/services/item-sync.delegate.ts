import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommandRepository } from '../../infrastructure/repositories/command.repository';
import {
  TransactionHelpers,
} from '../../../shared-kernel/outbox/transaction.service';
import {
  LIBRARY_EVENT_TYPES,
  buildItemCreatedOutboxPayload,
} from '../../../shared-kernel/outbox/outbox.events';
import { normalizeTags } from '../../../shared-kernel/utils/tag.utils';
import type {
  UpsertSyncItemCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../../../shared-kernel/core/types/entity-commands.types';

@Injectable()
export class ItemSyncDelegate {
  constructor(private readonly command: CommandRepository) {}

  async upsertFromSync(
    command: UpsertSyncItemCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    const userId = command.userId;
    if (command.existingId) {
      const existing = await tx.item.findUnique({
        where: { id: command.existingId },
        include: { itemTags: { include: { tag: true } } },
      });

      if (!existing) {
        throw new NotFoundException(`Item ${command.existingId} not found`);
      }

      if (existing.userId && existing.userId !== userId) {
        throw new ForbiddenException(
          `Item ${command.existingId} does not belong to user ${userId}`,
        );
      }

      if (
        !existing.userId &&
        existing.projectId &&
        existing.projectId !== (command as any).projectId
      ) {
        throw new ForbiddenException(
          `Item ${command.existingId} does not belong to the specified project`,
        );
      }

      const existingTagNames = (existing.itemTags || []).map(
        (it) => it.tag.name,
      );
      const mergedTags = normalizeTags([
        ...existingTagNames,
        ...(command.tags || []),
      ]);

      const itemProjectId =
        command.projectId || (command as any).projectId || undefined;
      const syncScope = { userId, projectId: itemProjectId };

      const updated = await this.command.update(
        userId,
        command.existingId,
        undefined,
        {
          ...command,
          tags: mergedTags,
          userId: command.userId,
        },
        tx,
        itemProjectId,
      );

      await helpers.appendChange(syncScope, {
        entityType: 'Item',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: { title: command.title },
      });

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      const itemProjectId =
        command.projectId || (command as any).projectId || undefined;
      const syncScope = { userId, projectId: itemProjectId };

      const created = await this.command.create(
        userId,
        {
          ...command,
          uploadedById: command.userId,
        },
        tx,
        itemProjectId,
      );

      await helpers.appendChange(syncScope, {
        entityType: 'Item',
        entityId: created.id,
        action: 'create',
        version: 1,
        data: { title: command.title },
      });

      await helpers.publishOutbox(
        syncScope,
        created.id,
        LIBRARY_EVENT_TYPES.ITEM_CREATED,
        buildItemCreatedOutboxPayload({
          itemId: created.id,
          userId,
          projectId: itemProjectId,
          title: created.title,
          source: 'external_sync',
        }),
      );

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const targetUserId = command.userId || '';
    const { entityId, reason, publishOutboxEventType, publishOutboxPayload } =
      command;
    const existing = await tx.item.findUnique({
      where: { id: entityId },
    });
    if (!existing) return;

    if (targetUserId && existing.userId && existing.userId !== targetUserId) {
      throw new ForbiddenException(
        `Item ${entityId} does not belong to user ${targetUserId}`,
      );
    }

    const itemProjectId =
      existing.projectId || (command as any).projectId || undefined;
    const syncScope = { userId: targetUserId, projectId: itemProjectId };

    await tx.item.update({
      where: { id: entityId },
      data: { deletedAt: new Date() },
    });
    await helpers.appendChange(syncScope, {
      entityType: 'Item',
      entityId,
      action: 'delete',
      version: existing.version + 1,
      data: { reason },
    });
    await helpers.recordTombstone(syncScope, {
      entityType: 'Item',
      entityId,
      deletedById: targetUserId || undefined,
    });
    await helpers.publishOutbox(
      syncScope,
      entityId,
      publishOutboxEventType ?? 'library.item.deleted',
      publishOutboxPayload ?? {
        itemId: entityId,
        reason,
        projectId: itemProjectId,
      },
    );
  }
}
