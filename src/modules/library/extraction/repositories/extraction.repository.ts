import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma } from '@prisma/client';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import { resolveOrCreateTags } from '@/modules/library/catalog/domain/creator-tag-payload.builder';
import { buildTipTapDocFromText } from '@/modules/library/core/domain/tiptap.domain';
import {
  EntityNotFoundException,
  normalizeProjectScopeId,
} from '@/modules/library/core';

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

  async findUniqueAttachment<
    I extends Prisma.AttachmentInclude = Prisma.AttachmentInclude,
  >(
    attachmentId: string,
    options?: {
      select?: Prisma.AttachmentSelect;
      include?: Prisma.Subset<I, Prisma.AttachmentInclude>;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.AttachmentGetPayload<{ include: I }> | null> {
    const client = this.getClient(tx);
    return client.attachment.findUnique({
      where: { id: attachmentId },
      ...options,
    }) as unknown as Promise<Prisma.AttachmentGetPayload<{
      include: I;
    }> | null>;
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

  async saveMetadataSourceRecord(
    itemId: string,
    sourceProvider: string,
    rawPayload: Prisma.InputJsonValue,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const existingRecords = await client.itemMetadata.findMany({
      where: { itemId, sourceProvider },
      select: { id: true, rawPayload: true },
    });

    const newFileId =
      rawPayload &&
      typeof rawPayload === 'object' &&
      !Array.isArray(rawPayload) &&
      typeof (rawPayload as Record<string, unknown>).fileId === 'string'
        ? ((rawPayload as Record<string, unknown>).fileId as string)
        : undefined;

    const supersededFileIds: string[] = [];
    if (existingRecords.length > 0) {
      for (const existing of existingRecords) {
        const payloadObj =
          existing.rawPayload &&
          typeof existing.rawPayload === 'object' &&
          !Array.isArray(existing.rawPayload)
            ? (existing.rawPayload as Record<string, unknown>)
            : null;
        if (
          payloadObj?.isOffloaded === true &&
          typeof payloadObj.fileId === 'string' &&
          payloadObj.fileId.length > 0 &&
          payloadObj.fileId !== newFileId
        ) {
          supersededFileIds.push(payloadObj.fileId);
        }
      }

      await client.itemMetadata.deleteMany({
        where: {
          id: { in: existingRecords.map((r) => r.id) },
        },
      });
    }

    const created = await client.itemMetadata.create({
      data: {
        itemId,
        sourceProvider,
        rawPayload,
      },
    });

    return {
      ...created,
      supersededFileIds,
    };
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
    return this.updateItemWithExtractedMetadata(itemId, data, tx);
  }

  async updateItemWithExtractedMetadata(
    itemId: string,
    data: Prisma.ItemUpdateInput,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    let mergedMetadata = data.metadata;

    if (
      data.metadata &&
      typeof data.metadata === 'object' &&
      !Array.isArray(data.metadata)
    ) {
      const freshItem = await client.item.findUnique({
        where: { id: itemId },
        select: { metadata: true },
      });
      const freshestMeta =
        freshItem?.metadata &&
        typeof freshItem.metadata === 'object' &&
        !Array.isArray(freshItem.metadata)
          ? (freshItem.metadata as Record<string, unknown>)
          : {};
      mergedMetadata = {
        ...freshestMeta,
        ...(data.metadata as Record<string, unknown>),
      } as Prisma.InputJsonValue;
    }

    return client.item.update({
      where: { id: itemId },
      data: {
        ...data,
        ...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {}),
        version: { increment: 1 },
      },
    });
  }

  async indexAttachmentPages(
    attachmentId: string,
    pages: Array<{
      pageIndex: number;
      textContent: string;
      charOffset?: number;
    }>,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!pages || pages.length === 0) return;
    const execute = async (client: Prisma.TransactionClient) => {
      if (typeof client.fullTextIndex?.deleteMany !== 'function') return;
      await client.fullTextIndex.deleteMany({
        where: { attachmentId },
      });

      const CHUNK_SIZE = 100;
      for (let i = 0; i < pages.length; i += CHUNK_SIZE) {
        const chunk = pages.slice(i, i + CHUNK_SIZE);
        await client.fullTextIndex.createMany({
          data: chunk.map((page, idx) => ({
            attachmentId,
            pageIndex: page.pageIndex ?? i + idx,
            textContent: (page.textContent || '').replace(/\0/g, ''),
            charOffset: page.charOffset ?? 0,
          })),
        });
      }
    };

    if (tx) {
      await execute(tx);
    } else if (typeof this.prisma.$transaction === 'function') {
      await this.prisma.$transaction(async (innerTx) => {
        await execute(innerTx);
      });
    } else {
      await execute(this.prisma as unknown as Prisma.TransactionClient);
    }
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
    scope: { userId?: string; projectId?: string | null } | string,
    excludeItemId: string,
    hintsOrTx?:
      | { dois?: string[]; years?: number[]; limit?: number }
      | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    const isHintsObj =
      hintsOrTx &&
      typeof hintsOrTx === 'object' &&
      !('item' in hintsOrTx) &&
      ('dois' in hintsOrTx || 'years' in hintsOrTx || 'limit' in hintsOrTx);
    const hints = isHintsObj
      ? (hintsOrTx as { dois?: string[]; years?: number[]; limit?: number })
      : undefined;
    const effectiveTx = isHintsObj
      ? tx
      : (hintsOrTx as Prisma.TransactionClient | undefined);

    const client = this.getClient(effectiveTx);
    let scopeWhere: Prisma.ItemWhereInput;
    if (typeof scope === 'object' && scope !== null) {
      const normalizedProjectId = normalizeProjectScopeId(scope.projectId);
      scopeWhere = normalizedProjectId
        ? { projectId: normalizedProjectId }
        : { userId: scope.userId, projectId: null };
    } else {
      scopeWhere = {
        OR: [{ projectId: scope }, { userId: scope, projectId: null }],
      };
    }

    const cleanDois =
      hints?.dois?.filter((d): d is string => Boolean(d && d.trim())) ?? [];
    const cleanYears =
      hints?.years?.filter(
        (y): y is number => typeof y === 'number' && Number.isFinite(y),
      ) ?? [];

    const hintOrFilters: Prisma.ItemWhereInput[] = [];
    if (cleanDois.length > 0) {
      hintOrFilters.push({ doi: { in: cleanDois } });
    }
    if (cleanYears.length > 0) {
      hintOrFilters.push({ year: { in: cleanYears } });
    }

    const combinedWhere: Prisma.ItemWhereInput = {
      ...scopeWhere,
      id: { not: excludeItemId },
      deletedAt: null,
      ...(hintOrFilters.length > 0 ? { OR: hintOrFilters } : {}),
    };

    const takeLimit =
      hints?.limit && hints.limit > 0 ? Math.min(hints.limit, 2000) : 500;

    return client.item.findMany({
      where: combinedWhere,
      take: takeLimit,
      select: {
        id: true,
        title: true,
        doi: true,
        year: true,
        metadata: true,
        contributors: {
          select: {
            lastName: true,
            fullName: true,
          },
          orderBy: { orderIndex: 'asc' },
          take: 3,
        },
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
      throw new EntityNotFoundException('Attachment not found', {
        attachmentId: params.attachmentId,
      });
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

    const resolvedTags = await resolveOrCreateTags(
      client,
      params.userId,
      normalized,
      'automatic',
      params.projectId ?? null,
    );

    if (resolvedTags.length > 0) {
      if (typeof client.itemTag?.createMany === 'function') {
        await client.itemTag.createMany({
          data: resolvedTags.map((t) => ({
            tagId: t.id,
            itemId: params.itemId,
            type: 'automatic',
          })),
          skipDuplicates: true,
        });
      } else if (typeof (client as any).itemTag?.upsert === 'function') {
        for (const t of resolvedTags) {
          await (client as any).itemTag.upsert({
            where: { itemId_tagId: { itemId: params.itemId, tagId: t.id } },
            create: { itemId: params.itemId, tagId: t.id, type: 'automatic' },
            update: {},
          });
        }
      } else if (false) await client.itemTag.createMany({
        data: resolvedTags.map((t) => ({
          tagId: t.id,
          itemId: params.itemId,
          type: 'automatic',
        })),
        skipDuplicates: true,
      });
    }

    const item = await client.item.findUnique({
      where: { id: params.itemId },
      select: { metadata: true },
    });
    if (item) {
      const currentMeta = (item.metadata as Record<string, unknown>) || {};
      const existingTags = Array.isArray(currentMeta.tags)
        ? (currentMeta.tags as unknown[]).filter(
            (t): t is string => typeof t === 'string',
          )
        : [];
      const mergedTags = normalizeAcademicTags([
        ...existingTags,
        ...normalized,
      ]);
      await client.item.update({
        where: { id: params.itemId },
        data: {
          metadata: {
            ...currentMeta,
            tags: mergedTags,
            keywords: mergedTags,
            labels: mergedTags,
          },
          version: { increment: 1 },
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
          version: { increment: 1 },
        },
      });
    }

    return createdCount;
  }
}
