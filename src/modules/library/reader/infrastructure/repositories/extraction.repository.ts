import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class ExtractionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async claimPendingOrRetryable(
    attachmentId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.attachment.updateMany({
      where: {
        id: attachmentId,
        extractionStatus: { in: ['PENDING', 'FAILED_RETRYABLE'] },
      },
      data: {
        extractionStatus: 'PROCESSING',
        extractionAttempts: { increment: 1 },
        extractionStartedAt: new Date(),
      },
    });
  }

  async claimStaleProcessing(
    attachmentId: string,
    staleCutoff: Date,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.attachment.updateMany({
      where: {
        id: attachmentId,
        extractionStatus: 'PROCESSING',
        extractionStartedAt: { lt: staleCutoff },
      },
      data: {
        extractionStatus: 'PROCESSING',
        extractionAttempts: { increment: 1 },
        extractionStartedAt: new Date(),
      },
    });
  }

  async findUniqueAttachment(
    attachmentId: string,
    options?: {
      select?: Prisma.AttachmentSelect;
      include?: Prisma.AttachmentInclude;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<any> {
    const client = this.getClient(tx);
    return client.attachment.findUnique({
      where: { id: attachmentId },
      ...options,
    });
  }

  async updateAttachmentFileId(
    attachmentId: string,
    fileId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.attachment.update({
      where: { id: attachmentId },
      data: { fileId },
    });
  }

  async saveItemMetadata(
    itemId: string,
    sourceProvider: string,
    rawPayload: any,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.itemMetadata.create({
      data: {
        itemId,
        sourceProvider,
        rawPayload,
      },
    });
  }

  async saveMetadataSourceRecord(
    itemId: string,
    sourceProvider: string,
    rawPayload: any,
    tx?: Prisma.TransactionClient,
  ) {
    return this.saveItemMetadata(itemId, sourceProvider, rawPayload, tx);
  }

  async updateAttachmentMetadata(
    attachmentId: string,
    metadata: any,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.attachment.update({
      where: { id: attachmentId },
      data: { metadata },
    });
  }

  async updateItem(
    itemId: string,
    data: Prisma.ItemUpdateInput,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.item.update({
      where: { id: itemId },
      data,
    });
  }

  async countContributors(itemId: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.contributor.count({
      where: { itemId },
    });
  }

  async createContributors(
    data: Prisma.ContributorCreateManyInput[],
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.contributor.createMany({
      data,
    });
  }

  async markReady(attachmentId: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.attachment.update({
      where: { id: attachmentId },
      data: {
        extractionStatus: 'READY',
        extractionCompletedAt: new Date(),
        extractionLastError: null,
      },
    });
  }

  async markFailed(
    attachmentId: string,
    status: 'FAILED_FINAL' | 'FAILED_RETRYABLE',
    error: string,
    isFinal: boolean,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.attachment.update({
      where: { id: attachmentId },
      data: {
        extractionStatus: status,
        extractionLastError: error,
        ...(isFinal ? { extractionCompletedAt: new Date() } : {}),
      },
    });
  }

  async findScopePapers(
    scopeId: string,
    excludeItemId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.item.findMany({
      where: {
        OR: [{ projectId: scopeId }, { userId: scopeId }],
        id: { not: excludeItemId },
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        doi: true,
      },
    });
  }

  async upsertItemCitationRelation(
    sourceItemId: string,
    targetItemId: string,
    description: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.itemRelation.upsert({
      where: {
        sourceItemId_targetItemId_relationType: {
          sourceItemId,
          targetItemId,
          relationType: 'cites',
        },
      },
      update: {},
      create: {
        sourceItemId,
        targetItemId,
        relationType: 'cites',
        description,
      },
    });
  }
}
