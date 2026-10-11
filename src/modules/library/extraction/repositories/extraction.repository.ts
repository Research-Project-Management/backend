import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';
import { normalizeAcademicTags } from '../../shared-kernel/utils/tag.utils';
import { buildTipTapDocFromText } from '../../shared-kernel/utils/tiptap.utils';

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
    rawPayload: Prisma.InputJsonValue,
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
    rawPayload: Prisma.InputJsonValue,
    tx?: Prisma.TransactionClient,
  ) {
    return this.saveItemMetadata(itemId, sourceProvider, rawPayload, tx);
  }

  async updateAttachmentMetadata(
    attachmentId: string,
    metadata: Prisma.InputJsonValue,
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

  async recordSearchablePdfRevision(
    params: {
      attachmentId: string;
      fileId: string;
      url: string;
      sizeBytes: bigint;
      fileHash: string;
      comment?: string;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const attachment = await client.attachment.findUnique({
      where: { id: params.attachmentId },
      include: {
        revisions: {
          orderBy: { revisionNumber: 'desc' },
          take: 1,
        },
      },
    });

    if (!attachment) {
      throw new Error(`Attachment ${params.attachmentId} not found`);
    }

    let latestRevisionNumber = attachment.revisions?.[0]?.revisionNumber ?? 0;
    if (latestRevisionNumber === 0) {
      await client.attachmentRevision.create({
        data: {
          attachmentId: attachment.id,
          revisionNumber: 1,
          fileId: attachment.fileId || null,
          fileHash: attachment.fileHash || '',
          sizeBytes: attachment.size ?? 0n,
          url: attachment.url || '',
          comment: 'Original scanned document',
        },
      });
      latestRevisionNumber = 1;
    }

    const nextRevisionNumber = latestRevisionNumber + 1;

    const revision = await client.attachmentRevision.create({
      data: {
        attachmentId: attachment.id,
        revisionNumber: nextRevisionNumber,
        fileId: params.fileId,
        fileHash: params.fileHash,
        sizeBytes: params.sizeBytes,
        url: params.url,
        comment:
          params.comment || `OCR Sandwich PDF (Revision ${nextRevisionNumber})`,
      },
    });

    await client.attachment.update({
      where: { id: attachment.id },
      data: {
        fileId: params.fileId,
        url: params.url,
        size: params.sizeBytes,
        fileHash: params.fileHash,
      },
    });

    return revision;
  }

  async countItemTags(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    return client.itemTag.count({
      where: { itemId },
    });
  }

  async syncItemTags(
    params: {
      userId: string;
      itemId: string;
      rawTags: string[];
      projectId?: string | null;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = this.getClient(tx);
    const normalized = normalizeAcademicTags(params.rawTags);
    if (normalized.length === 0) return [];

    const projectId = params.projectId ?? null;
    for (const tagName of normalized) {
      let tag = await client.tag.findFirst({
        where: {
          userId: params.userId,
          name: tagName,
          projectId,
        },
      });

      if (!tag) {
        tag = await client.tag.create({
          data: {
            userId: params.userId,
            createdById: params.userId,
            name: tagName,
            type: 'automatic',
            projectId,
          },
        });
      }

      await client.itemTag.upsert({
        where: {
          tagId_itemId: {
            tagId: tag.id,
            itemId: params.itemId,
          },
        },
        create: {
          tagId: tag.id,
          itemId: params.itemId,
          type: 'automatic',
        },
        update: {},
      });
    }

    const item = await client.item.findUnique({
      where: { id: params.itemId },
      select: { metadata: true },
    });
    if (item) {
      const currentMeta = (item.metadata as Record<string, any>) || {};
      const existingTags = Array.isArray(currentMeta.tags)
        ? currentMeta.tags
        : [];
      const mergedTags = Array.from(new Set([...existingTags, ...normalized]));
      await client.item.update({
        where: { id: params.itemId },
        data: {
          metadata: {
            ...currentMeta,
            tags: mergedTags,
            keywords: mergedTags,
          },
        },
      });
    }

    return normalized;
  }

  async countItemNotes(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    return client.note.count({
      where: { itemId, deletedAt: null },
    });
  }

  async createItemNotes(
    params: {
      userId: string;
      itemId: string;
      notes: Array<{ content: string; type?: string }>;
      projectId?: string | null;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    if (!params.notes || params.notes.length === 0) return 0;

    const existing = await client.note.findMany({
      where: { itemId: params.itemId, deletedAt: null },
      select: { contentMd: true },
    });
    const existingContents = new Set(existing.map((n) => n.contentMd.trim()));

    let createdCount = 0;
    for (const n of params.notes) {
      const cleanContent = n.content.trim();
      if (!cleanContent || existingContents.has(cleanContent)) continue;

      const title = n.type
        ? `Extracted Note (${n.type})`
        : 'Extracted Document Note';
      const contentJson = buildTipTapDocFromText(cleanContent);

      await client.note.create({
        data: {
          userId: params.userId,
          createdById: params.userId,
          projectId: params.projectId ?? null,
          itemId: params.itemId,
          title,
          contentMd: cleanContent,
          contentJson: contentJson as Prisma.InputJsonValue,
          tags: ['extracted', 'automatic'],
          version: 1,
        },
      });
      existingContents.add(cleanContent);
      createdCount++;
    }

    if (createdCount > 0) {
      await client.item.update({
        where: { id: params.itemId },
        data: {
          noteCount: { increment: createdCount },
        },
      });
    }

    return createdCount;
  }
}
