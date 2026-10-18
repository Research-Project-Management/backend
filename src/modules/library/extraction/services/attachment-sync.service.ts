import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma, AttachmentType, LinkMode } from '@prisma/client';
import { TransactionHelpers } from '@/modules/library/core';
import type {
  UpsertSyncAttachmentCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '@/modules/library/core/types/entity-commands.types';

@Injectable()
export class AttachmentSyncService {
  async upsertFromSync(
    command: UpsertSyncAttachmentCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    const projectId = command.projectId;
    const userId = command.userId;
    const actorId = userId || projectId || 'system';

    if (command.existingId) {
      const existing = await tx.attachment.findUnique({
        where: { id: command.existingId },
        include: { item: true },
      });

      if (!existing) {
        throw new NotFoundException(
          `Attachment ${command.existingId} not found`,
        );
      }

      const item = existing.item;
      if (projectId && item?.projectId && item.projectId !== projectId) {
        throw new ForbiddenException(
          `Attachment ${command.existingId} does not belong to project ${projectId}`,
        );
      } else if (
        !projectId &&
        userId &&
        item?.userId &&
        !item?.projectId &&
        item.userId !== userId
      ) {
        throw new ForbiddenException(
          `Attachment ${command.existingId} does not belong to user ${userId}`,
        );
      }

      const revisionCount = await tx.attachmentRevision.count({
        where: { attachmentId: command.existingId },
      });
      const nextRevisionNumber = revisionCount + 1;

      const updated = await tx.attachment.update({
        where: { id: command.existingId },
        data: {
          filename: command.filename,
          url: command.url,
          mimeType: command.mimeType,
          fileHash: command.fileHash,
          size: command.size !== undefined ? BigInt(command.size) : undefined,
        },
      });

      await tx.attachmentRevision.create({
        data: {
          attachmentId: updated.id,
          revisionNumber: nextRevisionNumber,
          fileHash: command.fileHash || '',
          sizeBytes: command.size !== undefined ? BigInt(command.size) : 0n,
          url: command.url,
          comment: 'Sync update',
        },
      });

      const effectiveProjectId =
        projectId || existing.item?.projectId || undefined;
      const syncScope = { userId: actorId, projectId: effectiveProjectId };

      await helpers.appendChange(syncScope, {
        entityType: 'Attachment',
        entityId: updated.id,
        action: 'update',
        version: nextRevisionNumber,
      });

      return { id: updated.id, isNew: false, version: nextRevisionNumber };
    } else {
      const parentItemId = command.itemId;
      if (!parentItemId) {
        throw new NotFoundException(
          `Parent item ID required for attachment ${command.filename}`,
        );
      }

      const item = await tx.item.findUnique({
        where: { id: parentItemId },
      });

      if (!item) {
        throw new NotFoundException(`Item ${parentItemId} not found`);
      }

      if (projectId && item.projectId && item.projectId !== projectId) {
        throw new ForbiddenException(
          `Item ${parentItemId} does not belong to project ${projectId}`,
        );
      } else if (
        !projectId &&
        userId &&
        item.userId &&
        !item.projectId &&
        item.userId !== userId
      ) {
        throw new ForbiddenException(
          `Item ${parentItemId} does not belong to user ${userId}`,
        );
      }

      let resolvedLinkMode: LinkMode | undefined = command.linkMode as
        LinkMode | undefined;
      if (!resolvedLinkMode) {
        if (
          command.mimeType === 'text/html' ||
          command.attachmentType === AttachmentType.snapshot
        ) {
          resolvedLinkMode = 'imported_url';
        } else if (
          !command.fileId &&
          command.url &&
          /^https?:\/\//i.test(command.url)
        ) {
          resolvedLinkMode = 'linked_url';
        } else {
          resolvedLinkMode = 'imported_file';
        }
      }

      const created = await tx.attachment.create({
        data: {
          itemId: parentItemId,
          linkMode: resolvedLinkMode,
          filename: command.filename,
          url: command.url,
          fileId: command.fileId,
          mimeType: command.mimeType,
          fileHash: command.fileHash,
          attachmentType: command.attachmentType
            ? (command.attachmentType as AttachmentType)
            : AttachmentType.primary_pdf,
          size: command.size !== undefined ? BigInt(command.size) : 0n,
        },
      });

      await tx.attachmentRevision.create({
        data: {
          attachmentId: created.id,
          revisionNumber: 1,
          fileHash: command.fileHash || '',
          sizeBytes: command.size !== undefined ? BigInt(command.size) : 0n,
          url: command.url,
          comment: 'Initial sync',
        },
      });

      const effectiveProjectId = projectId || item.projectId || undefined;
      const syncScope = { userId: actorId, projectId: effectiveProjectId };

      await helpers.appendChange(syncScope, {
        entityType: 'Attachment',
        entityId: created.id,
        action: 'create',
        version: 1,
      });

      await helpers.publishOutbox(
        syncScope,
        created.id,
        'library.attachment.created',
        { attachmentId: created.id, projectId: effectiveProjectId },
      );

      if (
        command.mimeType === 'application/pdf' ||
        command.filename?.toLowerCase().endsWith('.pdf')
      ) {
        await helpers.publishOutbox(
          syncScope,
          created.id,
          'library.attachment.extraction_requested',
          {
            attachmentId: created.id,
            itemId: created.itemId,
            userId: actorId,
            projectId: effectiveProjectId,
          },
        );
      }

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const projectId = command.projectId;
    const userId = command.userId;
    const actorId = userId || projectId || 'system';

    const itemWhere: Prisma.ItemWhereInput = {};
    if (projectId) {
      itemWhere.projectId = projectId;
    } else if (userId) {
      itemWhere.userId = userId;
    }

    const existing = await tx.attachment.findFirst({
      where: {
        id: command.entityId,
        ...(Object.keys(itemWhere).length > 0 ? { item: itemWhere } : {}),
      },
      include: { item: true },
    });
    if (!existing) return;

    const effectiveProjectId =
      projectId || existing.item?.projectId || undefined;
    const syncScope = { userId: actorId, projectId: effectiveProjectId };

    await tx.attachment.delete({ where: { id: command.entityId } });
    await helpers.appendChange(syncScope, {
      entityType: 'Attachment',
      entityId: command.entityId,
      action: 'delete',
      version: 1,
    });
    await helpers.recordTombstone(syncScope, {
      entityType: 'Attachment',
      entityId: command.entityId,
      deletedById: userId || undefined,
    });
  }
}
