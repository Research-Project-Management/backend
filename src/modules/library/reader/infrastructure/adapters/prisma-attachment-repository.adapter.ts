import { Injectable, Logger } from '@nestjs/common';
import { IAttachmentRepositoryPort } from '../../domain/ports/attachment-repository.port';
import { AttachmentAggregate } from '../../domain/model/attachment.aggregate';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { TransactionService } from '../../../shared-kernel/outbox/transaction.service';

/**
 * Infrastructure Adapter implementing IAttachmentRepositoryPort using Prisma.
 */
@Injectable()
export class PrismaAttachmentRepositoryAdapter implements IAttachmentRepositoryPort {
  private readonly logger = new Logger(PrismaAttachmentRepositoryAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly libraryTx: TransactionService,
  ) {}

  async findById(attachmentId: string): Promise<AttachmentAggregate | null> {
    const raw = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: {
        revisions: { orderBy: { revisionNumber: 'desc' } },
      },
    });

    if (!raw) return null;

    return AttachmentAggregate.reconstitute({
      id: raw.id,
      itemId: raw.itemId,
      filename: raw.filename,
      url: raw.url,
      mimeType: raw.mimeType,
      sizeBytes: raw.size,
      fileHash: raw.fileHash,
      revisionCount: raw.revisions?.length || 1,
      isExtracted:
        (raw as any).extractedAt !== null &&
        (raw as any).extractedAt !== undefined,
      pageCount: (raw as any).pageCount ?? null,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  async findByItemId(itemId: string): Promise<AttachmentAggregate[]> {
    const records = await this.prisma.attachment.findMany({
      where: { itemId },
      include: {
        revisions: { orderBy: { revisionNumber: 'desc' } },
      },
    });

    return records.map((raw) =>
      AttachmentAggregate.reconstitute({
        id: raw.id,
        itemId: raw.itemId,
        filename: raw.filename,
        url: raw.url,
        mimeType: raw.mimeType,
        sizeBytes: raw.size,
        fileHash: raw.fileHash,
        revisionCount: raw.revisions?.length || 1,
        isExtracted:
          (raw as any).extractedAt !== null &&
          (raw as any).extractedAt !== undefined,
        pageCount: (raw as any).pageCount ?? null,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
      }),
    );
  }

  async save(aggregate: AttachmentAggregate): Promise<void> {
    const domainEvents = aggregate.pullDomainEvents();

    await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const existing = await tx.attachment.findUnique({
        where: { id: aggregate.id },
        select: { id: true },
      });

      if (!existing) {
        // Create Attachment + Initial Revision
        await tx.attachment.create({
          data: {
            id: aggregate.id,
            itemId: aggregate.itemId,
            filename: aggregate.filename,
            url: aggregate.url,
            mimeType: aggregate.mimeType,
            size: aggregate.sizeBytes,
            fileHash: aggregate.fileHash ?? '',
            createdAt: aggregate.createdAt,
            updatedAt: aggregate.updatedAt,
            revisions: {
              create: {
                revisionNumber: 1,
                url: aggregate.url,
                fileHash: aggregate.fileHash ?? '',
                sizeBytes: aggregate.sizeBytes,
                comment: 'Initial attachment upload',
              },
            },
          },
        });
      } else {
        // Update metadata
        await tx.attachment.update({
          where: { id: aggregate.id },
          data: {
            filename: aggregate.filename,
            url: aggregate.url,
            size: aggregate.sizeBytes,
            fileHash: aggregate.fileHash ?? '',
            updatedAt: aggregate.updatedAt,
          },
        });
      }

      // Record outbox events
      for (const event of domainEvents) {
        await helpers.publishOutbox('system', aggregate.id, event.eventType, {
          eventId: event.eventId,
          occurredAt: event.occurredAt.toISOString(),
          aggregateId: aggregate.id,
          itemId: aggregate.itemId,
        });
      }
    });
  }

  async delete(attachmentId: string): Promise<void> {
    await this.prisma.attachment.delete({
      where: { id: attachmentId },
    });
  }
}
