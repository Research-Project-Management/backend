import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma } from '@prisma/client';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import {
  resolveOrCreateTags,
  deriveFirstAuthor,
} from '@/modules/library/catalog';
import { buildTipTapDocFromText } from '@/modules/library/core/domain/tiptap.domain';
import {
  EntityNotFoundException,
  normalizeProjectScopeId,
  ItemProvenancePolicy,
} from '@/modules/library/core';
import { sanitizeExtractedItemUpdateAgainstFreshState } from '@/modules/library/extraction/domain/extraction-metadata-merge.policy';

@Injectable()
export class ExtractionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async getExtractionStatusBreakdown(
    scopeOrTx?: { userId?: string; projectId?: string | null } | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ): Promise<Record<string, number>> {
    const isScopeObj =
      scopeOrTx && typeof scopeOrTx === 'object' && !('attachment' in scopeOrTx) &&
      ('userId' in scopeOrTx || 'projectId' in scopeOrTx);
    const scope = isScopeObj ? (scopeOrTx as { userId?: string; projectId?: string | null }) : undefined;
    const effectiveTx = isScopeObj ? tx : (scopeOrTx as Prisma.TransactionClient | undefined);
    const client = this.getClient(effectiveTx);
    if (typeof client.attachment?.groupBy !== 'function') return {};
    const validProjectId = normalizeProjectScopeId(scope?.projectId);
    const itemScopeWhere: Prisma.ItemWhereInput | undefined = validProjectId
      ? { projectId: validProjectId, deletedAt: null }
      : scope?.userId
        ? { userId: scope.userId, projectId: null, deletedAt: null }
        : undefined;
    const groups = await client.attachment.groupBy({
      by: ['extractionStatus'],
      where: { deletedAt: null, ...(itemScopeWhere ? { item: itemScopeWhere } : {}) },
      _count: { _all: true },
    });
    const breakdown: Record<string, number> = {};
    for (const row of groups) {
      const statusKey = String(row.extractionStatus ?? 'UNKNOWN');
      breakdown[statusKey] = row._count._all;
    }
    return breakdown;
  }

  async claimPendingOrRetryable(attachmentId: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.attachment.updateMany({
      where: { id: attachmentId, extractionStatus: { in: ['PENDING', 'FAILED_RETRYABLE'] } },
      data: {
        extractionStatus: 'PROCESSING',
        extractionAttempts: { increment: 1 },
        extractionStartedAt: new Date(),
      },
    });
  }

  async claimStaleProcessing(attachmentId: string, staleCutoff: Date, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.attachment.updateMany({
      where: { id: attachmentId, extractionStatus: 'PROCESSING', extractionStartedAt: { lt: staleCutoff } },
      data: {
        extractionStatus: 'PROCESSING',
        extractionAttempts: { increment: 1 },
        extractionStartedAt: new Date(),
      },
    });
  }

  async findUniqueAttachment<I extends Prisma.AttachmentInclude = Prisma.AttachmentInclude>(
    attachmentId: string,
    options?: { select?: Prisma.AttachmentSelect; include?: Prisma.Subset<I, Prisma.AttachmentInclude> },
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.AttachmentGetPayload<{ include: I }> | null> {
    const client = this.getClient(tx);
    return client.attachment.findUnique({
      where: { id: attachmentId },
      ...options,
    }) as unknown as Promise<Prisma.AttachmentGetPayload<{ include: I }> | null>;
  }

  async updateAttachmentFileId(attachmentId: string, fileId: string, tx?: Prisma.TransactionClient) {
    return this.getClient(tx).attachment.update({ where: { id: attachmentId }, data: { fileId } });
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
    const freshItem = await client.item.findUnique({
      where: { id: itemId },
      select: {
        userId: true,
        projectId: true,
        citationKey: true,
        title: true,
        doi: true,
        abstract: true,
        year: true,
        publicationTitle: true,
        itemType: true,
        metadata: true,
      },
    });

    const { sanitizedData, mergedMetadata } =
      await sanitizeExtractedItemUpdateAgainstFreshState({
        client,
        itemId,
        data,
        freshItem,
      });

    return client.item.update({
      where: { id: itemId },
      data: {
        ...sanitizedData,
        ...(mergedMetadata !== undefined ? { metadata: mergedMetadata as Prisma.InputJsonValue } : {}),
        version: { increment: 1 },
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        itemTags: { include: { tag: true } },
        attachments: { where: { deletedAt: null }, include: { revisions: true } },
        notesList: { where: { deletedAt: null } },
        collectionItems: { include: { collection: true } },
        identifiers: true,
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
    const execute = async (client: Prisma.TransactionClient | PrismaService) => {
      if (!client.fullTextIndex?.deleteMany) return;
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
    } else if (this.prisma.$transaction) {
      await this.prisma.$transaction(async (innerTx) => {
        await execute(innerTx);
      });
    } else {
      await execute(this.prisma);
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
    options?: { skipVersionIncrement?: boolean },
  ) {
    const client = this.getClient(tx);
    const result = await client.contributor.createMany({
      data,
    });
    const itemId = data[0]?.itemId;
    if (itemId && data.length > 0) {
      const firstAuthor = deriveFirstAuthor({
        contributors: data as unknown as Array<Record<string, unknown>>,
      });
      if (firstAuthor) {
        await client.item.update({
          where: { id: itemId },
          data: {
            firstAuthor,
            ...(options?.skipVersionIncrement ? {} : { version: { increment: 1 } }),
          },
        });
      }
    }
    return result;
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
    const relation = await client.itemRelation.upsert({
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
    return relation;
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

  async countItemTags(itemId: string, tx?: Prisma.TransactionClient): Promise<number> {
    return this.getClient(tx).itemTag.count({ where: { itemId } });
  }

  async syncItemTags(
    params: {
      userId: string;
      itemId: string;
      rawTags: string[];
      projectId?: string | null;
      skipVersionIncrement?: boolean;
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
      if (client.itemTag?.createMany) {
        await client.itemTag.createMany({
          data: resolvedTags.map((t) => ({ tagId: t.id, itemId: params.itemId, type: 'automatic' })),
          skipDuplicates: true,
        });
      } else if (client.itemTag?.upsert) {
        for (const t of resolvedTags) {
          await client.itemTag.upsert({
            where: { tagId_itemId: { itemId: params.itemId, tagId: t.id } },
            create: { itemId: params.itemId, tagId: t.id, type: 'automatic' },
            update: {},
          });
        }
      }

      const existingItem = await client.item.findUnique({
        where: { id: params.itemId },
        select: { metadata: true },
      });
      const meta = (existingItem?.metadata as Record<string, unknown>) || {};
      const existingTags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
      const existingKeywords = Array.isArray(meta.keywords)
        ? (meta.keywords as string[])
        : existingTags;
      const mergedTags = Array.from(new Set([...existingTags, ...normalized]));
      const mergedKeywords = Array.from(new Set([...existingKeywords, ...normalized]));

      await client.item.update({
        where: { id: params.itemId },
        data: {
          ...(params.skipVersionIncrement ? {} : { version: { increment: 1 } }),
          metadata: { ...meta, tags: mergedTags, keywords: mergedKeywords },
        },
      });
    }

    return normalized;
  }

  async countItemNotes(itemId: string, tx?: Prisma.TransactionClient): Promise<number> {
    return this.getClient(tx).note.count({ where: { itemId, deletedAt: null } });
  }

  async createItemNotes(
    params: {
      userId: string;
      itemId: string;
      notes: Array<{ content: string; type?: string }>;
      projectId?: string | null;
      skipVersionIncrement?: boolean;
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

    const toCreate: Prisma.NoteCreateManyInput[] = [];
    for (const n of params.notes) {
      const cleanContent = n.content.trim();
      if (!cleanContent || existingContents.has(cleanContent)) continue;
      const title = n.type ? `Extracted Note (${n.type})` : 'Extracted Document Note';
      const contentJson = buildTipTapDocFromText(cleanContent);
      toCreate.push({
        userId: params.userId,
        createdById: params.userId,
        projectId: params.projectId ?? null,
        itemId: params.itemId,
        title,
        contentMd: cleanContent,
        contentJson: contentJson as Prisma.InputJsonValue,
        tags: ['extracted', 'automatic'],
        version: 1,
      });
      existingContents.add(cleanContent);
    }

    const createdCount = toCreate.length;
    if (createdCount > 0) {
      if (client.note?.createMany) {
        await client.note.createMany({ data: toCreate });
      } else {
        for (const row of toCreate) {
          await client.note.create({ data: row });
        }
      }
      await client.item.update({
        where: { id: params.itemId },
        data: {
          noteCount: { increment: createdCount },
          ...(params.skipVersionIncrement ? {} : { version: { increment: 1 } }),
        },
      });
    }

    return createdCount;
  }

  async syncExtractedIdentifiers(
    itemId: string,
    identifiers: Array<{ type: string; value: string; canonicalUri: string }>,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (identifiers.length === 0) return;
    const rawClient = this.getClient(tx);
    const freshItem = rawClient.item?.findUnique
      ? await rawClient.item.findUnique({ where: { id: itemId }, select: { doi: true, metadata: true } })
      : null;
    const freshMeta = freshItem?.metadata && typeof freshItem.metadata === 'object' && !Array.isArray(freshItem.metadata)
      ? (freshItem.metadata as Record<string, unknown>) : {};
    const filtered = identifiers.filter((idObj) => {
      const lower = idObj.type.trim().toLowerCase();
      const t = lower === 'arxivid' || lower === 'arxiv' ? 'arxiv' : lower;
      const metaKey = t === 'arxiv' ? 'arxivId' : t;
      if (
        freshItem &&
        (ItemProvenancePolicy.isFieldLocked(freshMeta, metaKey) ||
          ItemProvenancePolicy.isFieldLocked(freshMeta, t))
      ) {
        return false;
      }
      const existingVal =
        t === 'doi' ? freshItem?.doi || freshMeta.doi : freshMeta[metaKey] || freshMeta[t];
      if (
        existingVal &&
        String(existingVal).trim() &&
        String(existingVal).trim().toLowerCase() !== idObj.value.trim().toLowerCase()
      ) {
        return false;
      }
      return true;
    });
    if (filtered.length === 0) return;
    if (!rawClient.itemIdentifier?.upsert) return;
    await Promise.all(
      filtered.map((idObj) => {
        const lower = idObj.type.trim().toLowerCase();
        const canonicalType = lower === 'arxivid' || lower === 'arxiv' ? 'arxiv' : lower;
        return rawClient.itemIdentifier.upsert({
          where: { itemId_type: { itemId, type: canonicalType } },
          update: { value: idObj.value, canonicalUri: idObj.canonicalUri },
          create: {
            itemId,
            type: canonicalType,
            value: idObj.value,
            canonicalUri: idObj.canonicalUri,
          },
        });
      }),
    );
  }
}
