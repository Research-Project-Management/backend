import { Injectable, Optional, Inject } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';
import { IStoragePort, STORAGE_PORT } from '../../storage/storage.port';

@Injectable()
export class AttachmentsRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findUnique(
    id: string,
    includeOptions?: Prisma.AttachmentInclude,
    tx?: Prisma.TransactionClient,
  ): Promise<any> {
    const client = this.getClient(tx);
    return client.attachment.findUnique({
      where: { id },
      include: includeOptions,
    });
  }

  async findFirst(
    where: Prisma.AttachmentWhereInput,
    include?: Prisma.AttachmentInclude,
    tx?: Prisma.TransactionClient,
  ): Promise<any> {
    const client = this.getClient(tx);
    return client.attachment.findFirst({
      where,
      include,
    });
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
    const client = this.getClient(tx);
    await client.attachment.updateMany({
      where: { itemId: { in: sourceItemIds } },
      data: { itemId: targetItemId },
    });
  }

  async updateLinkedFile(
    fileId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
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
}
