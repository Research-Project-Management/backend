import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommandRepository } from '../repositories/command.repository';
import { QueryRepository } from '../repositories/query.repository';
import {
  TransactionHelpers,
  LIBRARY_EVENT_TYPES,
  buildItemCreatedOutboxPayload,
} from '../../shared-kernel';
import { normalizeTags } from '../../shared-kernel/utils/tag.utils';
import type {
  UpsertSyncItemCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../../shared-kernel/core/types/entity-commands.types';

@Injectable()
export class ItemSyncDelegate {
  constructor(
    private readonly command: CommandRepository,
    private readonly query: QueryRepository,
  ) {}

  async upsertFromSync(
    command: UpsertSyncItemCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    const userId = command.userId;
    if (command.existingId) {
      const existing = await this.query.findById(
        userId,
        command.existingId,
        command.projectId,
        tx,
        false,
        true,
      );

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
        (it: any) => it.tag?.name || it.name,
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
    const existing = await this.query.findById(
      targetUserId,
      entityId,
      (command as any).projectId,
      tx,
      false,
      true,
    );
    if (!existing) return;

    if (targetUserId && existing.userId && existing.userId !== targetUserId) {
      throw new ForbiddenException(
        `Item ${entityId} does not belong to user ${targetUserId}`,
      );
    }

    const itemProjectId =
      existing.projectId || (command as any).projectId || undefined;
    const syncScope = { userId: targetUserId, projectId: itemProjectId };

    await this.command.delete(
      targetUserId,
      entityId,
      undefined,
      tx,
      itemProjectId,
    );
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
