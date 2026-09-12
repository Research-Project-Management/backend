import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma, AttachmentType } from '@prisma/client';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveTenantWorkspaceId } from '../../../core/utils/tenant.util';
import { createHash } from 'crypto';
import {
  TransactionService,
  TransactionHelpers,
} from '../outbox/transaction.service';
import {
  CreateAttachmentInput,
  ReplaceAttachmentFileInput,
} from './types/attachments.types';
import { validateAttachmentInvariants } from './utils/attachments.utils';

import { AttachmentsRepository } from './attachments.repository';
import {
  ITEM_EXISTENCE_PORT,
  IItemExistencePort,
} from '../items/ports/items.ports';

import type {
  UpsertSyncAttachmentCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../common/types/sync.types';
import { Inject } from '@nestjs/common';

import { calculateFileChecksum } from './utils/attachments.utils';

export { CreateAttachmentInput, ReplaceAttachmentFileInput };

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AttachmentsRepository,
    private readonly libraryTx: TransactionService,
    @Inject(ITEM_EXISTENCE_PORT)
    private readonly itemExistencePort: IItemExistencePort,
  ) {}

  /**
   * Computes SHA-256 hex digest of a file buffer.
   */
  calculateChecksum(buffer: Buffer): string {
    return calculateFileChecksum(buffer);
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

    const targetItemId = input.itemId;
    if (!targetItemId) {
      throw new BadRequestException('Item ID is required');
    }

    await this.itemExistencePort.assertExists(input.workspaceId, targetItemId);

    const resolvedFileId =
      input.fileId ||
      input.url?.match(/\/api\/files\/([a-zA-Z0-9-]+)\/content/)?.[1] ||
      null;

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const attachment = await tx.attachment.create({
        data: {
          itemId: targetItemId,
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

      if (resolvedFileId) {
        await this.repo.updateLinkedFile(resolvedFileId, targetItemId, tx);
      }

      await helpers.appendChange(input.workspaceId, {
        entityType: 'Attachment',
        entityId: attachment.id,
        action: 'create',
        version: 1,
        data: attachment,
      });

      await helpers.publishOutbox(
        input.workspaceId,
        attachment.id,
        'library.attachment.created',
        attachment,
      );

      if (attachment.mimeType === 'application/pdf') {
        await helpers.publishOutbox(
          input.workspaceId,
          attachment.id,
          'library.attachment.extraction_requested',
          {
            attachmentId: attachment.id,
            itemId: attachment.itemId,
            workspaceId: input.workspaceId,
          },
        );
      }

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

    const attachment = await this.repo.findUnique(attachmentId, {
      item: true,
      revisions: { orderBy: { revisionNumber: 'desc' }, take: 1 },
    });

    if (!attachment || attachment.item.workspaceId !== workspaceId) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    const nextRevisionNumber =
      (attachment.revisions[0]?.revisionNumber ?? 0) + 1;

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const updatedAttachment = await tx.attachment.update({
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

      await helpers.appendChange(attachment.item.workspaceId, {
        entityType: 'Attachment',
        entityId: attachmentId,
        action: 'update',
        version: nextRevisionNumber,
        data: { attachment: updatedAttachment, revision },
      });

      await helpers.publishOutbox(
        attachment.item.workspaceId,
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
    const attachment = await this.repo.findFirst({
      id: attachmentId,
      item: { workspaceId, deletedAt: null },
    });

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    return this.repo.findRevisions(attachment.id);
  }

  /**
   * Retrieves all attachments for an item in a workspace.
   */
  async getItemAttachments(workspaceId: string, itemId: string) {
    await this.itemExistencePort.assertExists(workspaceId, itemId);

    const attachments = await this.repo.findManyByItemId(itemId);

    return { attachments, total: attachments.length };
  }

  /**
   * Retrieves a specific attachment for an item in a workspace.
   */
  async getItemAttachment(
    workspaceId: string,
    itemId: string | undefined,
    attachmentId: string,
  ) {
    const where: any = {
      id: attachmentId,
      item: { workspaceId, deletedAt: null },
    };
    if (itemId) {
      where.itemId = itemId;
    }

    const attachment = await this.repo.findFirst(where, {
      revisions: { orderBy: { revisionNumber: 'desc' } },
    });

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    return { attachment };
  }

  /**
   * Deletes an attachment and records a tombstone.
   */
  async deleteAttachment(workspaceId: string, attachmentId: string) {
    if (!attachmentId) {
      throw new BadRequestException('Attachment ID is required');
    }

    const attachment = await this.repo.findFirst(
      {
        id: attachmentId,
        ...(workspaceId ? { item: { workspaceId } } : {}),
      },
      { item: true },
    );

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    const canonicalWorkspaceId = workspaceId || attachment.item.workspaceId;

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      await tx.attachment.delete({ where: { id: attachment.id } });

      await helpers.appendChange(canonicalWorkspaceId, {
        entityType: 'Attachment',
        entityId: attachment.id,
        action: 'delete',
        version: 1,
        data: { id: attachment.id },
      });

      await helpers.publishOutbox(
        canonicalWorkspaceId,
        attachment.id,
        'library.attachment.deleted',
        { attachmentId: attachment.id },
      );

      return { success: true };
    });
  }

  /**
   * Sync protocol adapter: transactional upsert for a Attachment from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncAttachmentCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    if (command.existingId) {
      const existing = await tx.attachment.findUnique({
        where: { id: command.existingId },
        include: { item: true },
      });

      if (!existing) {
        throw new NotFoundException(
          `Attachment ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      if (existing.item.workspaceId !== command.workspaceId) {
        throw new ForbiddenException(
          `Attachment ${command.existingId} does not belong to workspace ${command.workspaceId}`,
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

      if (!item || item.workspaceId !== command.workspaceId) {
        throw new NotFoundException(
          `Item ${parentItemId} not found in workspace ${command.workspaceId}`,
        );
      }

      const created = await tx.attachment.create({
        data: {
          itemId: parentItemId,
          filename: command.filename,
          url: command.url,
          mimeType: command.mimeType,
          fileHash: command.fileHash,
          attachmentType: command.attachmentType
            ? (command.attachmentType as AttachmentType)
            : AttachmentType.primary_pdf,
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
        entityType: 'Attachment',
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

      if (
        command.mimeType === 'application/pdf' ||
        command.filename?.toLowerCase().endsWith('.pdf')
      ) {
        await helpers.publishOutbox(
          command.workspaceId,
          created.id,
          'library.attachment.extraction_requested',
          {
            attachmentId: created.id,
            itemId: created.itemId,
            workspaceId: command.workspaceId,
          },
        );
      }

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  /**
   * Sync protocol adapter: transactional deletion for a Attachment from an external sync batch.
   */
  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const { workspaceId, entityId } = command;
    const canonicalWorkspaceId = await resolveTenantWorkspaceId(
      this.prisma,
      workspaceId,
    );
    const existing = await tx.attachment.findFirst({
      where: {
        id: entityId,
        item: { workspaceId: canonicalWorkspaceId },
      },
      include: { item: true },
    });
    if (!existing) return;

    await tx.attachment.delete({ where: { id: entityId } });
    await helpers.appendChange(canonicalWorkspaceId, {
      entityType: 'Attachment',
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
    await this.repo.reassignToItem(sourceItemIds, targetItemId, tx);
  }

  /**
   * Domain boundary helper: asserts that an attachment belongs to the given workspace.
   */
  async assertAttachmentInWorkspace(
    attachmentId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<any> {
    const attachment = await this.repo.findUnique(
      attachmentId,
      { item: true },
      tx,
    );
    if (!attachment || attachment.item.workspaceId !== workspaceId) {
      throw new NotFoundException(
        `Attachment ${attachmentId} not found in workspace ${workspaceId}`,
      );
    }
    return attachment;
  }

  /**
   * Sets an attachment as the primary attachment for an item.
   */
  async setPrimaryAttachment(
    workspaceId: string,
    itemId: string,
    attachmentId: string,
  ) {
    const canonicalWorkspaceId = await resolveTenantWorkspaceId(
      this.prisma,
      workspaceId,
    );
    const attachment = await this.repo.findFirst({
      id: attachmentId,
      itemId,
      item: { workspaceId: canonicalWorkspaceId },
    });
    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.attachment.updateMany({
        where: { itemId, attachmentType: 'primary_pdf' },
        data: { attachmentType: 'supplementary' },
      });
      await tx.attachment.update({
        where: { id: attachmentId },
        data: { attachmentType: 'primary_pdf' },
      });
    });

    return { success: true };
  }
}
