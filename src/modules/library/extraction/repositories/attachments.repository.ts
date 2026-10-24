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

  async syncItemAttachmentCounts(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!itemId) return;
    const client = this.getClient(tx);
    if (!client.attachment || !client.item) {
      return;
    }
    const rawCount = client.attachment?.count ? await client.attachment.count({
      where: { itemId, deletedAt: null },
    }) : 1;
    const activeCount = Math.max(0, rawCount);
    if (client.item?.updateMany) {
      await client.item.updateMany({
        where: { id: itemId },
        data: {
          hasFile: activeCount > 0,
          attachmentCount: activeCount,
        },
      });
    } else if (client.item?.update) {
      await client.item.update({
        where: { id: itemId },
        data: {
          hasFile: activeCount > 0,
          attachmentCount: activeCount,
        },
      });
    }
  }

  async create<
    I extends Prisma.AttachmentInclude = Prisma.AttachmentInclude,
  >(
    data: Prisma.AttachmentCreateInput,
    include?: Prisma.Subset<I, Prisma.AttachmentInclude>,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.AttachmentGetPayload<{ include: I }>> {
    const client = this.getClient(tx);
    const sanitizedData = { ...data } as Record<string, unknown>;
    if (sanitizedData.itemId && typeof sanitizedData.itemId === 'string') {
      if (!sanitizedData.item) {
        sanitizedData.item = { connect: { id: sanitizedData.itemId } };
      }
      delete sanitizedData.itemId;
    }
    const targetItemId = (sanitizedData.item as { connect?: { id?: string } })?.connect?.id;
    const isPrimaryPdf = sanitizedData.attachmentType === 'primary_pdf' || (!sanitizedData.attachmentType && sanitizedData.mimeType === 'application/pdf');
    if (targetItemId && isPrimaryPdf && client.attachment?.updateMany) {
      await client.attachment.updateMany({
        where: {
          itemId: targetItemId,
          attachmentType: 'primary_pdf',
          deletedAt: null,
        },
        data: {
          attachmentType: 'supplementary',
        },
      });
    }
    const created = (await client.attachment.create({
      data: sanitizedData as Prisma.AttachmentCreateInput,
      include,
    })) as Prisma.AttachmentGetPayload<{ include: I }> & { itemId?: string };
    if (created?.itemId) {
      await this.syncItemAttachmentCounts(created.itemId, tx);
    }
    return created;
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
    const existing = await client.attachment?.findUnique?.({
      where: { id },
      select: { id: true, itemId: true, deletedAt: true },
    });
    const deleted = await client.attachment.delete({
      where: { id },
    });
    const itemId = deleted?.itemId || existing?.itemId;
    if (itemId && (!existing || !existing.deletedAt)) {
      await this.syncItemAttachmentCounts(itemId, tx);
    }
    return deleted;
  }

  async countFileIdReferences(
    fileId: string,
    excludeAttachmentId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (!fileId) return 0;
    const client = this.getClient(tx);
    let count = 0;
    if (client.attachment?.count) {
      count += await client.attachment.count({
        where: {
          fileId,
          ...(excludeAttachmentId ? { id: { not: excludeAttachmentId } } : {}),
        },
      });
    }
    if (client.attachmentRevision?.count) {
      count += await client.attachmentRevision.count({
        where: {
          fileId,
          ...(excludeAttachmentId
            ? { attachmentId: { not: excludeAttachmentId } }
            : {}),
        },
      });
    }
    return count;
  }

  async reassignToItem(
    sourceItemIds: string[],
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (sourceItemIds.length === 0) return [];
    const cleanSourceIds = sourceItemIds.filter((id) => id !== targetItemId);
    if (cleanSourceIds.length === 0) return [];

    const client = this.getClient(tx);

    const allAttachments = await client.attachment.findMany({
      where: {
        itemId: { in: [targetItemId, ...cleanSourceIds] },
        deletedAt: null,
      },
      include: {
        revisions: {
          select: { fileId: true },
        },
      },
    });

    if (!allAttachments || allAttachments.length === 0) {
      await client.attachment.updateMany({
        where: { itemId: { in: cleanSourceIds } },
        data: { itemId: targetItemId },
      });
      return [];
    }

    // Order so targetItemId's existing attachments come first, then source attachments
    const sortedAttachments = [...allAttachments].sort((a, b) => {
      if (a.itemId === targetItemId && b.itemId !== targetItemId) return -1;
      if (a.itemId !== targetItemId && b.itemId === targetItemId) return 1;
      return 0;
    });

    const survivingByHash = new Map<string, (typeof sortedAttachments)[0]>();
    const survivingByUrl = new Map<string, (typeof sortedAttachments)[0]>();
    const survivingFileIds = new Set<string>();
    const deletedCandidateFileIds = new Set<string>();
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

        if (duplicateAnnotIdsToDelete.length > 0) {
          await client.annotation.deleteMany({
            where: { id: { in: duplicateAnnotIdsToDelete } },
          });
        }

        if (annotIdsToMove.length > 0) {
          await client.annotation.updateMany({
            where: { id: { in: annotIdsToMove } },
            data: { attachmentId: existingSurvivor.id },
          });
        }

        if (att.fileId) {
          deletedCandidateFileIds.add(att.fileId);
        }
        const attRevisions = (
          att as { revisions?: Array<{ fileId?: string | null }> }
        ).revisions;
        if (Array.isArray(attRevisions)) {
          for (const rev of attRevisions) {
            if (rev.fileId) {
              deletedCandidateFileIds.add(rev.fileId);
            }
          }
        }

        // Remove the redundant duplicate attachment
        await client.attachment.delete({ where: { id: att.id } });
        continue;
      }

      // Surviving attachment: register hash/url and enforce single primary_pdf
      if (hashKey) survivingByHash.set(hashKey, att);
      if (urlKey) survivingByUrl.set(urlKey, att);
      if (att.fileId) survivingFileIds.add(att.fileId);
      const survivorRevisions = (
        att as { revisions?: Array<{ fileId?: string | null }> }
      ).revisions;
      if (Array.isArray(survivorRevisions)) {
        for (const rev of survivorRevisions) {
          if (rev.fileId) survivingFileIds.add(rev.fileId);
        }
      }

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
        await client.attachment.update({
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

    await Promise.all([this.syncItemAttachmentCounts(targetItemId, tx), ...cleanSourceIds.map((srcId) => this.syncItemAttachmentCounts(srcId, tx))]);

    const orphanedFileIds = Array.from(deletedCandidateFileIds).filter(
      (fid) => !survivingFileIds.has(fid),
    );

    return orphanedFileIds;
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
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const run = async (client: Prisma.TransactionClient) => {
      await client.attachment.updateMany({
        where: { itemId, attachmentType: 'primary_pdf' },
        data: { attachmentType: 'supplementary' },
      });
      await client.attachment.update({
        where: { id: attachmentId },
        data: { attachmentType: 'primary_pdf' },
      });
    };
    if (tx) {
      await run(tx);
    } else {
      await this.prisma.$transaction(run);
    }
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

  async restoreByItemId(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    const result = await client.attachment.updateMany({
      where: { itemId, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    return result.count;
  }

}
