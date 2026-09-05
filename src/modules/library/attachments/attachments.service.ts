import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../core/database/prisma.service';
import { createHash } from 'crypto';
import {
  TransactionService,
  TransactionHelpers,
} from '../outbox/transaction.service';
import type {
  UpsertSyncAttachmentCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../sync/ports/sync.port';
import {
  CreateAttachmentInput,
  ReplaceAttachmentFileInput,
  validateAttachmentInvariants,
} from './types/attachment.types';

import { AttachmentsRepository } from './attachments.repository';

export { CreateAttachmentInput, ReplaceAttachmentFileInput };

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly attachmentsRepo: AttachmentsRepository,
    private readonly libraryTx: TransactionService,
  ) {}

  /**
   * Computes SHA-256 hex digest of a file buffer.
   */
  calculateChecksum(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Creates a new attachment with an initial Revision (revision 1).
   */
  async createAttachment(input: CreateAttachmentInput) {
    validateAttachmentInvariants({
      url: input.url,
      filename: input.filename,
      size: input.size,
      mimeType: input.mimeType,
      fileHash: input.fileHash,
    });

    const item = await this.attachmentsRepo.findCatalogItem(
      input.catalogItemId,
    );
    if (!item || item.workspaceId !== input.workspaceId || item.deletedAt) {
      throw new NotFoundException(
        `CatalogItem ${input.catalogItemId} not found`,
      );
    }

    const resolvedFileId =
      input.fileId ||
      input.url?.match(/\/api\/files\/([a-zA-Z0-9-]+)\/content/)?.[1] ||
      null;

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const attachment = await tx.catalogAttachment.create({
        data: {
          catalogItemId: input.catalogItemId,
          filename: input.filename,
          url: input.url,
          mimeType: input.mimeType ?? 'application/pdf',
          size: input.size ?? 0,
          fileHash: input.fileHash ?? '',
          fileId: resolvedFileId,
          revisions: {
            create: {
              revisionNumber: 1,
              url: input.url,
              fileHash: input.fileHash ?? '',
              sizeBytes: input.size ?? 0,
              comment: 'Initial file upload',
            },
          },
        },
        include: {
          revisions: {
            orderBy: { revisionNumber: 'desc' },
          },
        },
      });

      if (resolvedFileId && tx.file?.updateMany) {
        await tx.file.updateMany({
          where: { id: resolvedFileId },
          data: {
            linkedToType: 'Paper',
            linkedToId: input.catalogItemId,
          },
        });
      }

      await helpers.appendChange(item.workspaceId, {
        entityType: 'Attachment',
        entityId: attachment.id,
        action: 'create',
        version: 1,
        data: attachment,
      });

      await helpers.publishOutbox(
        item.workspaceId,
        attachment.id,
        'library.attachment.created',
        attachment,
      );

      return attachment;
    });
  }

  /**
   * Replaces an attachment's current file by creating an immutable sequential revision.
   */
  async addRevision(
    workspaceId: string,
    attachmentId: string,
    input: ReplaceAttachmentFileInput,
  ) {
    validateAttachmentInvariants({
      url: input.url,
      size: input.sizeBytes,
      fileHash: input.fileHash,
    });

    const attachment = await this.attachmentsRepo.findUnique(attachmentId, {
      catalogItem: true,
      revisions: { orderBy: { revisionNumber: 'desc' }, take: 1 },
    });

    if (!attachment || attachment.catalogItem.workspaceId !== workspaceId) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    const nextRevisionNumber =
      (attachment.revisions[0]?.revisionNumber ?? 0) + 1;

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const updatedAttachment = await tx.catalogAttachment.update({
        where: { id: attachmentId },
        data: {
          url: input.url,
          fileHash: input.fileHash,
          size: input.sizeBytes,
        },
      });

      const revision = await tx.attachmentRevision.create({
        data: {
          attachmentId,
          revisionNumber: nextRevisionNumber,
          url: input.url,
          fileHash: input.fileHash,
          sizeBytes: input.sizeBytes,
          comment: input.comment ?? `Revision ${nextRevisionNumber}`,
        },
      });

      await helpers.appendChange(attachment.catalogItem.workspaceId, {
        entityType: 'Attachment',
        entityId: attachmentId,
        action: 'update',
        version: nextRevisionNumber,
        data: { attachment: updatedAttachment, revision },
      });

      await helpers.publishOutbox(
        attachment.catalogItem.workspaceId,
        attachmentId,
        'library.attachment.revision_added',
        { attachmentId, revisionNumber: nextRevisionNumber },
      );

      return updatedAttachment;
    });
  }

  /**
   * Retrieves revision history for an attachment.
   */
  async getRevisions(workspaceId: string, attachmentId: string) {
    const attachment = await this.attachmentsRepo.findFirst(
      {
        id: attachmentId,
        catalogItem: { workspaceId, deletedAt: null },
      },
      { id: true } as any,
    );

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    return this.attachmentsRepo.findRevisions(attachment.id);
  }

  /**
   * Retrieves all attachments for a catalog item in a workspace.
   */
  async getItemAttachments(workspaceId: string, itemId: string) {
    const item = await this.attachmentsRepo.findCatalogItemInWorkspace(
      itemId,
      workspaceId,
    );
    if (!item) {
      throw new NotFoundException(`CatalogItem ${itemId} not found`);
    }

    const attachments = await this.attachmentsRepo.findManyByItemId(itemId);

    return { attachments, total: attachments.length };
  }

  /**
   * Retrieves a specific attachment for a catalog item in a workspace.
   */
  async getItemAttachment(
    workspaceId: string,
    itemId: string,
    attachmentId: string,
  ) {
    const attachment = await this.attachmentsRepo.findFirst(
      {
        id: attachmentId,
        catalogItemId: itemId,
        catalogItem: { workspaceId, deletedAt: null },
      },
      {
        revisions: { orderBy: { revisionNumber: 'desc' } },
      },
    );

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    return { attachment };
  }

  /**
   * Deletes an attachment and records a tombstone.
   */
  async deleteAttachment(workspaceId?: string, attachmentId?: string) {
    const targetId = attachmentId || workspaceId;
    if (!targetId) {
      throw new BadRequestException('Attachment ID is required');
    }

    const attachment = await this.attachmentsRepo.findFirst(
      {
        id: targetId,
        ...(workspaceId && attachmentId
          ? { catalogItem: { workspaceId } }
          : {}),
      },
      { catalogItem: true },
    );

    if (!attachment) {
      throw new NotFoundException(`Attachment ${targetId} not found`);
    }

    const effectiveWsId =
      workspaceId && attachmentId
        ? workspaceId
        : attachment.catalogItem.workspaceId;

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      await tx.catalogAttachment.delete({ where: { id: attachment.id } });

      await helpers.appendChange(effectiveWsId, {
        entityType: 'Attachment',
        entityId: attachment.id,
        action: 'delete',
        version: 1,
        data: { id: attachment.id },
      });

      await helpers.publishOutbox(
        effectiveWsId,
        attachment.id,
        'library.attachment.deleted',
        { attachmentId: attachment.id },
      );

      return { success: true };
    });
  }

  /**
   * Sync protocol adapter: transactional upsert for a CatalogAttachment from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncAttachmentCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    if (command.existingId) {
      const existing = await tx.catalogAttachment.findUnique({
        where: { id: command.existingId },
        include: { catalogItem: true },
      });

      if (!existing) {
        throw new NotFoundException(
          `Attachment ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      if (existing.catalogItem.workspaceId !== command.workspaceId) {
        throw new ForbiddenException(
          `Attachment ${command.existingId} does not belong to workspace ${command.workspaceId}`,
        );
      }

      const revisionCount = await tx.attachmentRevision.count({
        where: { attachmentId: command.existingId },
      });
      const nextRevisionNumber = revisionCount + 1;

      const updated = await tx.catalogAttachment.update({
        where: { id: command.existingId },
        data: {
          filename: command.filename,
          url: command.url,
          mimeType: command.mimeType,
          fileHash: command.fileHash,
          size: command.size !== undefined ? command.size : undefined,
        },
      });

      await tx.attachmentRevision.create({
        data: {
          attachmentId: updated.id,
          revisionNumber: nextRevisionNumber,
          fileHash: command.fileHash || '',
          sizeBytes: command.size || 0,
          url: command.url,
          comment: 'Sync update',
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'CatalogAttachment',
        entityId: updated.id,
        action: 'update',
        version: nextRevisionNumber,
      });

      return { id: updated.id, isNew: false, version: nextRevisionNumber };
    } else {
      if (!command.catalogItemId) {
        throw new NotFoundException(
          `Parent catalog item ID required for attachment ${command.filename}`,
        );
      }

      const item = await tx.catalogItem.findUnique({
        where: { id: command.catalogItemId },
      });

      if (!item || item.workspaceId !== command.workspaceId) {
        throw new NotFoundException(
          `Catalog item ${command.catalogItemId} not found in workspace ${command.workspaceId}`,
        );
      }

      const created = await tx.catalogAttachment.create({
        data: {
          catalogItemId: command.catalogItemId,
          filename: command.filename,
          url: command.url,
          mimeType: command.mimeType,
          fileHash: command.fileHash,
          attachmentType: (command.attachmentType as any) || 'primary_pdf',
          size: command.size || 0,
        },
      });

      await tx.attachmentRevision.create({
        data: {
          attachmentId: created.id,
          revisionNumber: 1,
          fileHash: command.fileHash || '',
          sizeBytes: command.size || 0,
          url: command.url,
          comment: 'Initial sync',
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'CatalogAttachment',
        entityId: created.id,
        action: 'create',
        version: 1,
      });

      await helpers.publishOutbox(
        command.workspaceId,
        created.id,
        'library.attachment.created',
        { attachmentId: created.id },
      );

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  /**
   * Sync protocol adapter: transactional deletion for a CatalogAttachment from an external sync batch.
   */
  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const { workspaceId, entityId } = command;
    const existing = await tx.catalogAttachment.findUnique({
      where: { id: entityId },
      include: { catalogItem: true },
    });
    if (!existing) return;

    if (existing.catalogItem.workspaceId !== workspaceId) {
      throw new ForbiddenException(
        `Attachment ${entityId} does not belong to workspace ${workspaceId}`,
      );
    }

    await tx.catalogAttachment.delete({ where: { id: entityId } });
    await helpers.appendChange(workspaceId, {
      entityType: 'CatalogAttachment',
      entityId,
      action: 'delete',
      version: 1,
    });
  }

  /**
   * Domain merge helper: reassigns all attachments from source duplicate items to target item.
   */
  async reassignToItem(
    sourceItemIds: string[],
    targetItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await this.attachmentsRepo.reassignToItem(sourceItemIds, targetItemId, tx);
  }
}
