import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class AttachmentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findCatalogItem(itemId: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.catalogItem.findUnique({
      where: { id: itemId },
    });
  }

  async findCatalogItemInWorkspace(
    itemId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.catalogItem.findFirst({
      where: { id: itemId, workspaceId, deletedAt: null },
    });
  }

  async findUnique(
    id: string,
    includeOptions?: Prisma.CatalogAttachmentInclude,
    tx?: Prisma.TransactionClient,
  ): Promise<any> {
    const client = this.getClient(tx);
    return client.catalogAttachment.findUnique({
      where: { id },
      include: includeOptions,
    });
  }

  async findFirst(
    where: Prisma.CatalogAttachmentWhereInput,
    include?: Prisma.CatalogAttachmentInclude,
    tx?: Prisma.TransactionClient,
  ): Promise<any> {
    const client = this.getClient(tx);
    return client.catalogAttachment.findFirst({
      where,
      include,
    });
  }

  async findManyByItemId(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.catalogAttachment.findMany({
      where: { catalogItemId: itemId },
      include: {
        revisions: { orderBy: { revisionNumber: 'desc' } },
      },
    });
  }

  async findRevisions(
    attachmentId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.attachmentRevision.findMany({
      where: { attachmentId },
      orderBy: { revisionNumber: 'desc' },
    });
  }

  async countRevisions(
    attachmentId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.attachmentRevision.count({
      where: { attachmentId },
    });
  }

  async create(
    data: Prisma.CatalogAttachmentCreateInput,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.catalogAttachment.create({
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
    data: Prisma.CatalogAttachmentUpdateInput,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.catalogAttachment.update({
      where: { id },
      data,
    });
  }

  async delete(
    id: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.catalogAttachment.delete({
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
    const client = this.getClient(tx);
    await client.catalogAttachment.updateMany({
      where: { catalogItemId: { in: sourceItemIds } },
      data: { catalogItemId: targetItemId },
    });
  }

  async updateLinkedFile(
    fileId: string,
    catalogItemId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    if (fileId && (client as any).file?.updateMany) {
      await (client as any).file.updateMany({
        where: { id: fileId },
        data: {
          linkedToType: 'Paper',
          linkedToId: catalogItemId,
        },
      });
    }
  }
}
