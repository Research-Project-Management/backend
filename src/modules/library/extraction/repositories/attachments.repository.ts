import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma } from '@prisma/client';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';

@Injectable()
export class AttachmentsRepository {
  private readonly logger = new Logger(AttachmentsRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findUnique<
    I extends Prisma.AttachmentInclude = Prisma.AttachmentInclude,
  >(
    id: string,
    includeOptions?: Prisma.Subset<I, Prisma.AttachmentInclude>,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.AttachmentGetPayload<{ include: I }> | null> {
    const client = this.getClient(tx);
    return client.attachment.findUnique({
      where: { id },
      include: includeOptions,
    }) as unknown as Promise<Prisma.AttachmentGetPayload<{
      include: I;
    }> | null>;
  }

  async findFirst<
    I extends Prisma.AttachmentInclude = Prisma.AttachmentInclude,
  >(
    where: Prisma.AttachmentWhereInput,
    include?: Prisma.Subset<I, Prisma.AttachmentInclude>,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.AttachmentGetPayload<{ include: I }> | null> {
    const client = this.getClient(tx);
    return client.attachment.findFirst({
      where,
      include,
    }) as unknown as Promise<Prisma.AttachmentGetPayload<{
      include: I;
    }> | null>;
  }

  async findManyByItemId(itemId: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.attachment.findMany({
      where: { itemId },
      include: {
        revisions: { orderBy: { revisionNumber: 'desc' } },
      },
    });
  }

  async findRevisions(attachmentId: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.attachmentRevision.findMany({
      where: { attachmentId },
      orderBy: { revisionNumber: 'desc' },
    });
  }

  async countRevisions(attachmentId: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.attachmentRevision.count({
      where: { attachmentId },
    });
  }

  async create(
    data: Prisma.AttachmentCreateInput,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.attachment.create({
      data,
      include: {
        revisions: {
          orderBy: { revisionNumber: 'desc' },
        },
      },
    });
  }

  async update(
    id: string,
    data: Prisma.AttachmentUpdateInput,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.attachment.update({
      where: { id },
      data,
    });
  }

  async delete(id: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.attachment.delete({
      where: { id },
    });
  }

  async createRevision(
    data: Prisma.AttachmentRevisionCreateInput,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.attachmentRevision.create({
      data,
    });
  }

  async reassignToItem(
    sourceItemIds: string[],
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (sourceItemIds.length === 0) return;
    const cleanSourceIds = sourceItemIds.filter((id) => id !== targetItemId);
    if (cleanSourceIds.length === 0) return;

    const client = this.getClient(tx);

    const allAttachments = await client.attachment.findMany({
      where: {
        itemId: { in: [targetItemId, ...cleanSourceIds] },
        deletedAt: null,
      },
    });

    if (!allAttachments || allAttachments.length === 0) {
      await client.attachment.updateMany({
        where: { itemId: { in: cleanSourceIds } },
        data: { itemId: targetItemId },
      });
      return;
    }

    // Order so targetItemId's existing attachments come first, then source attachments
    const sortedAttachments = [...allAttachments].sort((a, b) => {
      if (a.itemId === targetItemId && b.itemId !== targetItemId) return -1;
      if (a.itemId !== targetItemId && b.itemId === targetItemId) return 1;
      return 0;
    });

    const survivingByHash = new Map<string, (typeof sortedAttachments)[0]>();
    const survivingByUrl = new Map<string, (typeof sortedAttachments)[0]>();
    let hasPrimaryPdf = false;

    for (const att of sortedAttachments) {
      const hashKey =
        typeof att.fileHash === 'string' && att.fileHash.trim().length > 0
          ? att.fileHash.trim().toLowerCase()
          : undefined;
      const urlKey =
        !hashKey &&
        typeof att.url === 'string' &&
        att.url.trim().length > 0 &&
        att.linkMode === 'linked_url'
          ? att.url.trim()
          : undefined;

      const existingSurvivor =
        (hashKey ? survivingByHash.get(hashKey) : undefined) ||
        (urlKey ? survivingByUrl.get(urlKey) : undefined);

      if (existingSurvivor && existingSurvivor.id !== att.id) {
        // Consolidate annotations from duplicate attachment onto existingSurvivor
        if (typeof client.annotation?.findMany === 'function') {
          const [survivorAnnots, dupAnnots] = await Promise.all([
            client.annotation.findMany({
              where: { attachmentId: existingSurvivor.id, deletedAt: null },
            }),
            client.annotation.findMany({
              where: { attachmentId: att.id, deletedAt: null },
            }),
          ]);

          const duplicateAnnotIdsToDelete: string[] = [];
          const annotIdsToMove: string[] = [];

          for (const dupAnn of dupAnnots) {
            const dupQuote = (
              (
                dupAnn as {
                  quoteText?: string | null;
                  textSelection?: string | null;
                }
              ).quoteText ??
              (dupAnn as { textSelection?: string | null }).textSelection ??
              ''
            )
              .trim()
              .toLowerCase();
            const isIdentical = survivorAnnots.some((sa) => {
              const saQuote = (
                (
                  sa as {
                    quoteText?: string | null;
                    textSelection?: string | null;
                  }
                ).quoteText ??
                (sa as { textSelection?: string | null }).textSelection ??
                ''
              )
                .trim()
                .toLowerCase();
              return (
                sa.pageIndex === dupAnn.pageIndex &&
                sa.type === dupAnn.type &&
                dupQuote.length > 0 &&
                saQuote === dupQuote
              );
            });

            if (isIdentical) {
              duplicateAnnotIdsToDelete.push(dupAnn.id);
            } else {
              annotIdsToMove.push(dupAnn.id);
              survivorAnnots.push(dupAnn);
            }
          }

          if (
            duplicateAnnotIdsToDelete.length > 0 &&
            typeof client.annotation?.deleteMany === 'function'
          ) {
            await client.annotation.deleteMany({
              where: { id: { in: duplicateAnnotIdsToDelete } },
            });
          }

          if (
            annotIdsToMove.length > 0 &&
            typeof client.annotation?.updateMany === 'function'
          ) {
            await client.annotation.updateMany({
              where: { id: { in: annotIdsToMove } },
              data: { attachmentId: existingSurvivor.id },
            });
          }
        } else if (typeof client.annotation?.updateMany === 'function') {
          await client.annotation.updateMany({
            where: { attachmentId: att.id },
            data: { attachmentId: existingSurvivor.id },
          });
        }

        // Remove the redundant duplicate attachment
        if (typeof client.attachment?.delete === 'function') {
          await client.attachment.delete({ where: { id: att.id } });
        } else if (typeof client.attachment?.deleteMany === 'function') {
          await client.attachment.deleteMany({ where: { id: att.id } });
        }
        continue;
      }

      // Surviving attachment: register hash/url and enforce single primary_pdf
      if (hashKey) survivingByHash.set(hashKey, att);
      if (urlKey) survivingByUrl.set(urlKey, att);

      const isPrimaryPdf = att.attachmentType === 'primary_pdf';
      let nextAttachmentType = att.attachmentType;
      if (isPrimaryPdf) {
        if (!hasPrimaryPdf) {
          hasPrimaryPdf = true;
        } else {
          nextAttachmentType = 'supplementary';
        }
      }

      if (
        att.itemId !== targetItemId ||
        nextAttachmentType !== att.attachmentType
      ) {
        if (typeof client.attachment?.update === 'function') {
          await client.attachment.update({
            where: { id: att.id },
            data: {
              itemId: targetItemId,
              ...(nextAttachmentType !== att.attachmentType
                ? { attachmentType: nextAttachmentType }
                : {}),
            },
          });
        } else {
          await client.attachment.updateMany({
            where: { id: att.id },
            data: {
              itemId: targetItemId,
              ...(nextAttachmentType !== att.attachmentType
                ? { attachmentType: nextAttachmentType }
                : {}),
            },
          });
        }
      }
    }
  }

  async updateLinkedFile(
    fileId: string,
    itemId: string,
    _tx?: Prisma.TransactionClient,
  ) {
    if (!fileId) return;
    if (this.storagePort?.linkFile) {
      await this.storagePort.linkFile({
        fileId,
        linkedToType: 'Paper',
        linkedToId: itemId,
      });
    }
  }

  async findMany(
    where: Prisma.AttachmentWhereInput,
    include?: Prisma.AttachmentInclude,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.attachment.findMany({
      where,
      include,
    });
  }

  async setPrimaryAttachment(
    itemId: string,
    attachmentId: string,
  ): Promise<void> {
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
  }

  async renameAttachment(
    attachmentId: string,
    newFilename: string,
    fileId?: string,
  ) {
    const updated = await this.prisma.attachment.update({
      where: { id: attachmentId },
      data: {
        filename: newFilename,
      },
    });
    if (fileId) {
      try {
        await this.prisma.file.update({
          where: { id: fileId },
          data: { filename: newFilename },
        });
      } catch (err: unknown) {
        this.logger.debug(
          `Could not sync filename on file record ${fileId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return updated;
  }

  async batchRename(
    updates: Array<{ id: string; filename: string; fileId?: string }>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const item of updates) {
        await tx.attachment.update({
          where: { id: item.id },
          data: {
            filename: item.filename,
          },
        });
        if (item.fileId) {
          try {
            await tx.file.update({
              where: { id: item.fileId },
              data: { filename: item.filename },
            });
          } catch (err: unknown) {
            this.logger.debug(
              `Could not sync filename on file record ${item.fileId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    });
  }

  async deleteManyByItemId(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    const result = await client.attachment.deleteMany({
      where: { itemId },
    });
    return result.count;
  }

  async softDeleteByItemId(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    const result = await client.attachment.updateMany({
      where: { itemId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return result.count;
  }
}
