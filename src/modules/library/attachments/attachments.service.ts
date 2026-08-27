import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { createHash } from 'crypto';
import { LibraryTransactionService } from '../sync-core/library-transaction.service';

export interface CreateAttachmentInput {
  catalogItemId: string;
  filename: string;
  url: string;
  mimeType?: string;
  size?: number;
  fileHash?: string;
  fileId?: string;
}

export interface ReplaceAttachmentFileInput {
  url: string;
  fileHash: string;
  sizeBytes: number;
  comment?: string;
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly libraryTx: LibraryTransactionService,
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
    const item = await this.prisma.catalogItem.findUnique({
      where: { id: input.catalogItemId },
    });
    if (!item) {
      throw new NotFoundException(
        `CatalogItem ${input.catalogItemId} not found`,
      );
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const attachment = await tx.catalogAttachment.create({
        data: {
          catalogItemId: input.catalogItemId,
          filename: input.filename,
          url: input.url,
          mimeType: input.mimeType ?? 'application/pdf',
          size: input.size ?? 0,
          fileHash: input.fileHash ?? '',
          fileId: input.fileId ?? null,
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
  async addRevision(attachmentId: string, input: ReplaceAttachmentFileInput) {
    const attachment = await this.prisma.catalogAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        catalogItem: true,
        revisions: { orderBy: { revisionNumber: 'desc' }, take: 1 },
      },
    });

    if (!attachment) {
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
  async getRevisions(attachmentId: string) {
    return this.prisma.attachmentRevision.findMany({
      where: { attachmentId },
      orderBy: { revisionNumber: 'desc' },
    });
  }
}
