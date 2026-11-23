import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma } from '@prisma/client';
import { syncItemDenormalizedCountsInClient } from '@/modules/library/core';

@Injectable()
export class AttachmentsRepository {
  private readonly logger = new Logger(AttachmentsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

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
      where: { itemId, deletedAt: null },
      include: { revisions: { orderBy: { revisionNumber: 'desc' } } },
    });
  }

  async syncItemAttachmentCounts(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!itemId) return;
    await syncItemDenormalizedCountsInClient(this.getClient(tx), itemId, {
      attachments: true,
    });
  }

  async create<I extends Prisma.AttachmentInclude = Prisma.AttachmentInclude>(
    data: Prisma.AttachmentCreateInput,
    include?: Prisma.Subset<I, Prisma.AttachmentInclude>,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.AttachmentGetPayload<{ include: I }>> {
    const client = this.getClient(tx);
    const sanitizedData = { ...data } as Record<string, unknown>;
    if (sanitizedData.itemId && typeof sanitizedData.itemId === 'string') {
      if (!sanitizedData.item)
        sanitizedData.item = { connect: { id: sanitizedData.itemId } };
      delete sanitizedData.itemId;
    }
    const targetItemId = (sanitizedData.item as { connect?: { id?: string } })
      ?.connect?.id;
    const targetFileId =
      typeof sanitizedData.fileId === 'string'
        ? sanitizedData.fileId
        : undefined;
    const isPrimaryPdf =
      sanitizedData.attachmentType === 'primary_pdf' ||
      (!sanitizedData.attachmentType &&
        sanitizedData.mimeType === 'application/pdf');

    if (
      targetItemId &&
      targetFileId &&
      client.attachment?.findFirst &&
      client.attachment?.update
    ) {
      const existingSameFile = await client.attachment.findFirst({
        where: { itemId: targetItemId, fileId: targetFileId, deletedAt: null },
      });
      if (existingSameFile) {
        if (isPrimaryPdf && client.attachment?.updateMany) {
          await client.attachment.updateMany({
            where: {
              itemId: targetItemId,
              id: { not: existingSameFile.id },
              attachmentType: 'primary_pdf',
              deletedAt: null,
            },
            data: { attachmentType: 'supplementary' },
          });
        }
        const updatePayload: Record<string, unknown> = {};
        for (const strKey of [
          'filename',
          'title',
          'url',
          'mimeType',
          'attachmentType',
          'fileHash',
        ] as const) {
          if (
            typeof sanitizedData[strKey] === 'string' &&
            sanitizedData[strKey]
          ) {
            updatePayload[strKey] = sanitizedData[strKey];
          }
        }
        if (
          typeof sanitizedData.size === 'number' ||
          typeof sanitizedData.size === 'bigint'
        ) {
          updatePayload.size = sanitizedData.size;
        }
        if (
          sanitizedData.metadata &&
          typeof sanitizedData.metadata === 'object'
        ) {
          const existingMeta =
            existingSameFile.metadata &&
            typeof existingSameFile.metadata === 'object' &&
            !Array.isArray(existingSameFile.metadata)
              ? (existingSameFile.metadata as Record<string, unknown>)
              : {};
          updatePayload.metadata = {
            ...existingMeta,
            ...(sanitizedData.metadata as Record<string, unknown>),
          };
        }
        const updated = (await client.attachment.update({
          where: { id: existingSameFile.id },
          data: updatePayload,
          include,
        })) as Prisma.AttachmentGetPayload<{ include: I }> & {
          itemId?: string;
        };
        await this.syncItemAttachmentCounts(targetItemId, tx);
        return updated;
      }
    }

    if (targetItemId && isPrimaryPdf && client.attachment?.updateMany) {
      await client.attachment.updateMany({
        where: {
          itemId: targetItemId,
          attachmentType: 'primary_pdf',
          deletedAt: null,
        },
        data: { attachmentType: 'supplementary' },
      });
    }
    const created = (await client.attachment.create({
      data: sanitizedData as Prisma.AttachmentCreateInput,
      include,
    })) as Prisma.AttachmentGetPayload<{ include: I }> & { itemId?: string };
    if (created?.itemId)
      await this.syncItemAttachmentCounts(created.itemId, tx);
    return created;
  }

  async update(
    id: string,
    data: Prisma.AttachmentUpdateInput,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const updated = await client.attachment.update({ where: { id }, data });
    if (updated?.itemId)
      await this.syncItemAttachmentCounts(updated.itemId, tx);
    return updated;
  }

  async delete(id: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    const existing = await client.attachment?.findUnique?.({
      where: { id },
      select: { id: true, itemId: true, attachmentType: true, deletedAt: true },
    });
    const deleted = await client.attachment.delete({ where: { id } });
    const itemId = deleted?.itemId || existing?.itemId;
    if (itemId && (!existing || !existing.deletedAt)) {
      if (
        (existing?.attachmentType === 'primary_pdf' ||
          (deleted as { attachmentType?: string } | undefined)
            ?.attachmentType === 'primary_pdf') &&
        client.attachment?.findFirst &&
        client.attachment?.update
      ) {
        const nextPrimaryCandidate = await client.attachment.findFirst({
          where: {
            itemId,
            deletedAt: null,
            mimeType: 'application/pdf',
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true, attachmentType: true },
        });
        if (
          nextPrimaryCandidate &&
          nextPrimaryCandidate.attachmentType !== 'primary_pdf'
        ) {
          await client.attachment.update({
            where: { id: nextPrimaryCandidate.id },
            data: { attachmentType: 'primary_pdf' },
          });
        }
      }
      await this.syncItemAttachmentCounts(itemId, tx);
    }
    return deleted;
  }

  async countFileIdReferences(
    fileId: string,
    excludeAttachmentId?: string,
    tx?: Prisma.TransactionClient,
    excludeItemId?: string,
    spaceId?: string,
  ): Promise<number> {
    if (!fileId) return 0;
    const client = this.getClient(tx);
    const activeItemFilter = {
      deletedAt: null,
      ...(spaceId ? { spaceId } : {}),
    };
    const [attCount, revCount] = await Promise.all([
      client.attachment?.count
        ? client.attachment.count({
            where: {
              fileId,
              deletedAt: null,
              item: activeItemFilter,
              ...(excludeAttachmentId
                ? { id: { not: excludeAttachmentId } }
                : {}),
              ...(excludeItemId ? { itemId: { not: excludeItemId } } : {}),
            },
          })
        : Promise.resolve(0),
      client.attachmentRevision?.count
        ? client.attachmentRevision.count({
            where: {
              fileId,
              ...(excludeAttachmentId
                ? { attachmentId: { not: excludeAttachmentId } }
                : {}),
              attachment: {
                deletedAt: null,
                item: activeItemFilter,
                ...(excludeItemId ? { itemId: { not: excludeItemId } } : {}),
              },
            },
          })
        : Promise.resolve(0),
    ]);
    return attCount + revCount;
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
      await Promise.all([
        this.syncItemAttachmentCounts(targetItemId, tx),
        ...cleanSourceIds.map((srcId) =>
          this.syncItemAttachmentCounts(srcId, tx),
        ),
      ]);
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
    const survivingFileIds = new Set<string>(
      sortedAttachments
        .filter((a) => a.itemId === targetItemId)
        .flatMap((a) => [
          ...(a.fileId ? [a.fileId] : []),
          ...(Array.isArray(a.revisions)
            ? a.revisions
                .map((r) => r.fileId)
                .filter((fid): fid is string => Boolean(fid))
            : []),
        ]),
    );
    const candidateOrphanFileIds: string[] = [];
    let hasPrimaryPdf = false;

    for (const attachment of sortedAttachments) {
      const hashKey =
        typeof attachment.fileHash === 'string' &&
        attachment.fileHash.trim().length > 0
          ? attachment.fileHash.trim().toLowerCase()
          : undefined;
      const urlKey =
        !hashKey &&
        typeof attachment.url === 'string' &&
        attachment.url.trim().length > 0 &&
        attachment.linkMode === 'linked_url'
          ? attachment.url.trim()
          : undefined;

      const existingSurvivor =
        (hashKey ? survivingByHash.get(hashKey) : undefined) ||
        (urlKey ? survivingByUrl.get(urlKey) : undefined);

      if (existingSurvivor && existingSurvivor.id !== attachment.id) {
        // Consolidate annotations, structure, FTS, and reading states from duplicate attachment onto existingSurvivor
        const [
          survivorAnnots,
          dupAnnots,
          survivorFtsCount,
          survivorStruct,
          dupReadingStates,
        ] = await Promise.all([
          client.annotation?.findMany?.({
            where: { attachmentId: existingSurvivor.id, deletedAt: null },
          }) ?? Promise.resolve([]),
          client.annotation?.findMany?.({
            where: { attachmentId: attachment.id, deletedAt: null },
          }) ?? Promise.resolve([]),
          typeof client.fullTextIndex?.updateMany === 'function' &&
          typeof client.fullTextIndex?.count === 'function'
            ? client.fullTextIndex
                .count({ where: { attachmentId: existingSurvivor.id } })
                .catch(() => 0)
            : Promise.resolve(0),
          typeof client.attachmentStructure?.updateMany === 'function' &&
          typeof client.attachmentStructure?.findUnique === 'function'
            ? client.attachmentStructure
                .findUnique({ where: { attachmentId: existingSurvivor.id } })
                .catch(() => null)
            : Promise.resolve(null),
          typeof client.attachmentReadingState?.findMany === 'function'
            ? client.attachmentReadingState
                .findMany({ where: { attachmentId: attachment.id } })
                .catch(() => [])
            : Promise.resolve([]),
        ]);

        const duplicateAnnotIdsToDelete: string[] = [];
        const annotIdsToMove: string[] = [];
        const extractQuote = (a: {
          quoteText?: string | null;
          textSelection?: string | null;
        }) => (a.quoteText ?? a.textSelection ?? '').trim().toLowerCase();
        const extractComment = (a: { comment?: string | null }) =>
          (a.comment ?? '').trim();

        for (const dupAnn of dupAnnots) {
          const dupQuote = extractQuote(dupAnn);
          const dupComment = extractComment(dupAnn);
          const isIdentical = survivorAnnots.some((sa) => {
            const saQuote = extractQuote(sa);
            const saComment = extractComment(sa);
            return (
              sa.pageIndex === dupAnn.pageIndex &&
              sa.type === dupAnn.type &&
              dupQuote.length > 0 &&
              saQuote === dupQuote &&
              (dupComment.length === 0 || dupComment === saComment)
            );
          });
          if (isIdentical) duplicateAnnotIdsToDelete.push(dupAnn.id);
          else {
            annotIdsToMove.push(dupAnn.id);
            survivorAnnots.push(dupAnn);
          }
        }

        const consolidationWrites: Promise<unknown>[] = [];
        if (duplicateAnnotIdsToDelete.length > 0) {
          consolidationWrites.push(
            client.annotation.updateMany({
              where: { id: { in: duplicateAnnotIdsToDelete } },
              data: { deletedAt: new Date(), version: { increment: 1 } },
            }),
          );
        }
        if (annotIdsToMove.length > 0) {
          consolidationWrites.push(
            client.annotation.updateMany({
              where: { id: { in: annotIdsToMove } },
              data: {
                attachmentId: existingSurvivor.id,
                itemId: targetItemId,
                version: { increment: 1 },
              },
            }),
          );
        }
        if (client.fullTextIndex?.updateMany && survivorFtsCount === 0) {
          consolidationWrites.push(
            Promise.resolve(
              client.fullTextIndex.updateMany({
                where: { attachmentId: attachment.id },
                data: { attachmentId: existingSurvivor.id },
              }),
            ).catch(() => undefined),
          );
        }
        if (client.attachmentStructure?.updateMany && !survivorStruct) {
          consolidationWrites.push(
            Promise.resolve(
              client.attachmentStructure.updateMany({
                where: { attachmentId: attachment.id },
                data: { attachmentId: existingSurvivor.id },
              }),
            ).catch(() => undefined),
          );
        }
        if (consolidationWrites.length > 0)
          await Promise.all(consolidationWrites);

        if (
          typeof client.attachmentReadingState?.findMany === 'function' &&
          Array.isArray(dupReadingStates) &&
          dupReadingStates.length > 0
        ) {
          try {
            const existingChecks = await Promise.all(
              dupReadingStates.map((rs) =>
                typeof client.attachmentReadingState.findUnique === 'function'
                  ? client.attachmentReadingState.findUnique({
                      where: {
                        userId_attachmentId: {
                          userId: rs.userId,
                          attachmentId: existingSurvivor.id,
                        },
                      },
                    })
                  : Promise.resolve(null),
              ),
            );
            await Promise.all(
              dupReadingStates.map(async (rs, idx) => {
                if (existingChecks[idx]) return;
                const data = { attachmentId: existingSurvivor.id };
                if (
                  typeof client.attachmentReadingState.update === 'function'
                ) {
                  await client.attachmentReadingState.update({
                    where: {
                      userId_attachmentId: {
                        userId: rs.userId,
                        attachmentId: rs.attachmentId,
                      },
                    },
                    data,
                  });
                } else if (
                  typeof client.attachmentReadingState.updateMany === 'function'
                ) {
                  await client.attachmentReadingState.updateMany({
                    where: { userId: rs.userId, attachmentId: rs.attachmentId },
                    data,
                  });
                }
              }),
            );
          } catch {
            // Ignore unique constraint collisions
          }
        }
        // Soft-delete redundant duplicate attachment so original attachment rows are preserved in trash/audit
        if (typeof client.attachment.update === 'function') {
          await client.attachment.update({
            where: { id: attachment.id },
            data: { deletedAt: new Date() },
          });
          if (attachment.fileId) candidateOrphanFileIds.push(attachment.fileId);
        } else if (typeof client.attachment.updateMany === 'function') {
          await client.attachment.updateMany({
            where: { id: attachment.id },
            data: { deletedAt: new Date() },
          });
          if (attachment.fileId) candidateOrphanFileIds.push(attachment.fileId);
        } else if (typeof client.attachment.delete === 'function') {
          await client.attachment.delete({ where: { id: attachment.id } });
          if (attachment.fileId) candidateOrphanFileIds.push(attachment.fileId);
        }
        continue;
      }

      // Surviving attachment: register hash/url and enforce single primary_pdf
      if (hashKey) survivingByHash.set(hashKey, attachment);
      if (urlKey) survivingByUrl.set(urlKey, attachment);
      if (attachment.fileId) survivingFileIds.add(attachment.fileId);
      if (Array.isArray(attachment.revisions)) {
        for (const rev of attachment.revisions) {
          if (rev.fileId) survivingFileIds.add(rev.fileId);
        }
      }

      const isPrimaryPdf = attachment.attachmentType === 'primary_pdf';
      let nextAttachmentType = attachment.attachmentType;
      if (isPrimaryPdf) {
        if (!hasPrimaryPdf) {
          hasPrimaryPdf = true;
        } else {
          nextAttachmentType = 'supplementary';
        }
      }

      if (
        attachment.itemId !== targetItemId ||
        nextAttachmentType !== attachment.attachmentType
      ) {
        const isMovingItem = attachment.itemId !== targetItemId;
        await client.attachment.update({
          where: { id: attachment.id },
          data: {
            itemId: targetItemId,
            ...(nextAttachmentType !== attachment.attachmentType
              ? { attachmentType: nextAttachmentType }
              : {}),
          },
        });
        if (isMovingItem) {
          await Promise.all([
            client.annotation?.updateMany?.({
              where: { attachmentId: attachment.id },
              data: { itemId: targetItemId },
            }),
          ]);
        }
      }
    }

    await Promise.all([
      this.syncItemAttachmentCounts(targetItemId, tx),
      ...cleanSourceIds.map((srcId) =>
        this.syncItemAttachmentCounts(srcId, tx),
      ),
    ]);

    const orphanedFileIds = Array.from(
      new Set(
        candidateOrphanFileIds.filter((fid) => !survivingFileIds.has(fid)),
      ),
    );
    return orphanedFileIds;
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
        where: { itemId, attachmentType: 'primary_pdf', deletedAt: null },
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

  private async applyAttachmentFilenameAndFileRename(
    attachmentId: string,
    newFilename: string,
    _fileId: string | undefined,
    client: Prisma.TransactionClient,
  ) {
    const updated = await client.attachment.update({
      where: { id: attachmentId },
      data: { filename: newFilename },
    });
    if (updated?.itemId && client.libraryItem?.updateMany) {
      await client.libraryItem.updateMany({
        where: { id: updated.itemId },
        data: { version: { increment: 1 } },
      });
    }
    return updated;
  }

  async renameAttachment(
    attachmentId: string,
    newFilename: string,
    fileId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    return this.applyAttachmentFilenameAndFileRename(
      attachmentId,
      newFilename,
      fileId,
      this.getClient(tx),
    );
  }

  async batchRename(
    updates: Array<{ id: string; filename: string; fileId?: string }>,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!updates || updates.length === 0) return;
    const orderedUpdates = [...updates].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const run = async (client: Prisma.TransactionClient) => {
      await Promise.all(
        orderedUpdates.map((item) =>
          this.applyAttachmentFilenameAndFileRename(
            item.id,
            item.filename,
            item.fileId,
            client,
          ),
        ),
      );
    };
    if (tx) await run(tx);
    else await this.prisma.$transaction(run);
  }

  async deleteManyByItemId(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    const count = (await client.attachment.deleteMany({ where: { itemId } }))
      .count;
    await this.syncItemAttachmentCounts(itemId, client);
    return count;
  }

  async softDeleteByItemId(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const count = (
      await this.getClient(tx).attachment.updateMany({
        where: { itemId, deletedAt: null },
        data: { deletedAt: new Date() },
      })
    ).count;
    await this.syncItemAttachmentCounts(itemId, tx);
    return count;
  }
}
