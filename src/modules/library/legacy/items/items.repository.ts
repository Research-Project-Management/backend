import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, CatalogItem } from '@prisma/client';
import { ITEM_INCLUDE, ItemRecord } from './types/items.types';
import { PdfAnnotation } from '../annotations/types/annotations.types';
import { StoredRelation } from '../relations/types/relations.types';

@Injectable()
export class ItemsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prisma.workspace.findFirst({
      where: {
        OR: [
          { id: workspaceIdOrSlug },
          { slug: workspaceIdOrSlug },
          { url: workspaceIdOrSlug },
        ],
        deletedAt: null,
      },
      select: { id: true },
    });
  }

  async resolveWorkspaceId(workspaceIdOrSlug: string): Promise<string> {
    const ws = await this.resolveWorkspace(workspaceIdOrSlug);
    return ws?.id ?? workspaceIdOrSlug;
  }

  async findWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
  ): Promise<string | null> {
    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId },
      select: { role: true },
    });
    return member?.role ?? null;
  }

  async findItems(
    where: Prisma.CatalogItemWhereInput,
    options?: {
      skip?: number;
      take?: number;
      orderBy?: Prisma.CatalogItemOrderByWithRelationInput[];
    },
  ): Promise<ItemRecord[]> {
    return this.prisma.catalogItem.findMany({
      where,
      include: ITEM_INCLUDE,
      orderBy: options?.orderBy || { createdAt: 'desc' },
      take: options?.take,
      skip: options?.skip,
    });
  }

  async countItems(where: Prisma.CatalogItemWhereInput): Promise<number> {
    return this.prisma.catalogItem.count({ where });
  }

  async findItemById(itemId: string): Promise<ItemRecord | null> {
    return this.prisma.catalogItem.findUnique({
      where: { id: itemId },
      include: ITEM_INCLUDE,
    });
  }

  async findItemByIdInWorkspace(
    workspaceId: string,
    itemId: string,
  ): Promise<ItemRecord | null> {
    return this.prisma.catalogItem.findFirst({
      where: { id: itemId, workspaceId },
      include: ITEM_INCLUDE,
    });
  }

  async findCollectionById(collectionId: string) {
    return this.prisma.collection.findUnique({
      where: { id: collectionId },
    });
  }

  async findItemByDoi(
    workspaceId: string,
    doi: string,
  ): Promise<ItemRecord | null> {
    const item = await this.prisma.catalogItem.findFirst({
      where: {
        workspaceId,
        deletedAt: null,
        doi: { equals: doi.trim(), mode: 'insensitive' },
      },
      include: ITEM_INCLUDE,
    });
    return item ?? null;
  }

  async createItem(
    data:
      Prisma.CatalogItemCreateInput | Prisma.CatalogItemUncheckedCreateInput,
  ) {
    return this.prisma.catalogItem.create({
      data: data as Prisma.CatalogItemCreateInput,
      include: ITEM_INCLUDE,
    });
  }

  async updateItem(
    itemId: string,
    data:
      Prisma.CatalogItemUpdateInput | Prisma.CatalogItemUncheckedUpdateInput,
  ) {
    return this.prisma.catalogItem.update({
      where: { id: itemId },
      data: data,
      include: ITEM_INCLUDE,
    });
  }

  async purgeItem(itemId: string) {
    return this.prisma.catalogItem.delete({
      where: { id: itemId },
    });
  }

  async purgeItemInWorkspace(workspaceId: string, itemId: string) {
    return this.prisma.catalogItem.deleteMany({
      where: { id: itemId, workspaceId },
    });
  }

  async restoreItem(itemId: string) {
    return this.prisma.catalogItem.update({
      where: { id: itemId },
      data: { deletedAt: null },
      include: ITEM_INCLUDE,
    });
  }

  async createAttachment(
    data:
      | Prisma.CatalogAttachmentCreateInput
      | Prisma.CatalogAttachmentUncheckedCreateInput,
  ) {
    return this.prisma.catalogAttachment.create({
      data: data as Prisma.CatalogAttachmentCreateInput,
    });
  }

  async deleteAttachment(attachmentId: string) {
    return this.prisma.catalogAttachment.delete({
      where: { id: attachmentId },
    });
  }

  async deleteAttachmentForItem(itemId: string, attachmentId: string) {
    return this.prisma.catalogAttachment.deleteMany({
      where: {
        id: attachmentId,
        catalogItemId: itemId,
      },
    });
  }

  async resolveUniqueCitationKey(
    workspaceId: string,
    baseKey: string,
    excludeItemId?: string,
  ): Promise<string> {
    const existing = await this.prisma.catalogItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        citationKey: {
          startsWith: baseKey,
        },
        ...(excludeItemId && { id: { not: excludeItemId } }),
      },
      select: { citationKey: true },
    });

    const keySet = new Set(existing.map((p) => p.citationKey));
    if (!keySet.has(baseKey)) {
      return baseKey;
    }

    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    for (let i = 0; i < alphabet.length; i++) {
      const candidate = `${baseKey}${alphabet[i]}`;
      if (!keySet.has(candidate)) {
        return candidate;
      }
    }

    return `${baseKey}-${Date.now().toString(36)}`;
  }

  async mutateItemExtra(
    itemId: string,
    mutator: (
      currentExtra: Record<string, any>,
    ) => Record<string, any> | Promise<Record<string, any>>,
  ): Promise<{
    item: ItemRecord;
    extraObj: Record<string, any>;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const currentItem = await tx.catalogItem.findUnique({
        where: { id: itemId },
        select: { id: true, extra: true },
      });

      if (!currentItem) {
        throw new NotFoundException(`Item with ID ${itemId} not found`);
      }

      let extraObj: Record<string, any> = {};
      if (currentItem.extra && currentItem.extra.trim()) {
        try {
          extraObj = JSON.parse(currentItem.extra);
        } catch {
          extraObj = {};
        }
      }

      const updatedExtraObj = await mutator(extraObj);
      const updatedExtraString = JSON.stringify(updatedExtraObj);

      const item = await tx.catalogItem.update({
        where: { id: itemId },
        data: { extra: updatedExtraString },
        include: ITEM_INCLUDE,
      });

      return { item, extraObj: updatedExtraObj };
    });
  }

  async findDistinctLabels(workspaceId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ label: string }[]>`
      SELECT DISTINCT UNNEST(labels) AS label
      FROM "papers"
      WHERE workspace_id = ${workspaceId}
        AND deleted_at IS NULL
        AND labels != '{}'
      ORDER BY label ASC
    `;
    return rows.map((r) => r.label).filter(Boolean);
  }

  async findFirstUserId(): Promise<string | null> {
    const u = await this.prisma.user.findFirst({ select: { id: true } });
    return u?.id ?? null;
  }

  async findDoiDuplicates(
    workspaceId: string,
  ): Promise<{ doi: string; itemIds: string[] }[]> {
    const rows = await this.prisma.$queryRaw<
      { doi: string; item_ids: string[] }[]
    >`
      SELECT
        LOWER(TRIM(doi)) AS doi,
        ARRAY_AGG(id ORDER BY created_at ASC) AS item_ids
      FROM "papers"
      WHERE workspace_id  = ${workspaceId}
        AND deleted_at    IS NULL
        AND doi           IS NOT NULL
        AND TRIM(doi)     != ''
        AND LENGTH(TRIM(doi)) > 3
      GROUP BY LOWER(TRIM(doi))
      HAVING COUNT(*) > 1
    `;
    return rows.map((r) => ({ doi: r.doi, itemIds: r.item_ids }));
  }

  async findIntegrityStats(workspaceId: string): Promise<{
    totalItems: number;
    missingDoiCount: number;
    missingYearCount: number;
    missingAuthorsCount: number;
    missingPdfCount: number;
    unhealthyCount: number;
  }> {
    const missingPdfWhere: Prisma.CatalogItemWhereInput = {
      workspaceId,
      deletedAt: null,
      fileUrl: '',
      attachments: {
        none: {
          OR: [
            { mimeType: { contains: 'pdf', mode: 'insensitive' } },
            { filename: { endsWith: '.pdf', mode: 'insensitive' } },
          ],
        },
      },
    };

    const [rows, missingPdfCount, unhealthyCount] = await Promise.all([
      this.prisma.$queryRaw<
        {
          total_items: bigint;
          missing_doi: bigint;
          missing_year: bigint;
          missing_authors: bigint;
        }[]
      >`
        SELECT
          COUNT(*)                                                           AS total_items,
          COUNT(*) FILTER (WHERE doi IS NULL OR TRIM(doi) = '')             AS missing_doi,
          COUNT(*) FILTER (WHERE year IS NULL)                              AS missing_year,
          COUNT(*) FILTER (WHERE authors = '{}' OR authors IS NULL)         AS missing_authors
        FROM "papers"
        WHERE workspace_id = ${workspaceId}
          AND deleted_at IS NULL
      `,
      this.prisma.catalogItem.count({ where: missingPdfWhere }),
      this.prisma.catalogItem.count({
        where: {
          workspaceId,
          deletedAt: null,
          OR: [
            { doi: null },
            { doi: '' },
            { year: null },
            { authors: { isEmpty: true } },
            missingPdfWhere,
          ],
        },
      }),
    ]);
    const r = rows[0] ?? {
      total_items: 0n,
      missing_doi: 0n,
      missing_year: 0n,
      missing_authors: 0n,
    };
    return {
      totalItems: Number(r.total_items),
      missingDoiCount: Number(r.missing_doi),
      missingYearCount: Number(r.missing_year),
      missingAuthorsCount: Number(r.missing_authors),
      missingPdfCount,
      unhealthyCount,
    };
  }

  async executeMergeItemsTransaction(args: {
    masterId: string;
    sourceIds: string[];
    consolidatedNotes: any[];
    consolidatedLabels: string[];
    now: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.catalogItem.update({
        where: { id: args.masterId },
        data: {
          notes: args.consolidatedNotes as any,
          labels: args.consolidatedLabels,
        },
      });

      await tx.catalogAttachment.updateMany({
        where: { catalogItemId: { in: args.sourceIds } },
        data: { catalogItemId: args.masterId },
      });

      await tx.catalogItem.updateMany({
        where: { id: { in: args.sourceIds } },
        data: { deletedAt: args.now },
      });
    });
  }

  private parseAnnotations(extraString: string | null): PdfAnnotation[] {
    if (!extraString?.trim()) return [];
    try {
      const parsed = JSON.parse(extraString);
      return Array.isArray(parsed.annotations) ? parsed.annotations : [];
    } catch {
      return [];
    }
  }

  private parseRelations(extraString: string | null): StoredRelation[] {
    if (!extraString?.trim()) return [];
    try {
      const parsed = JSON.parse(extraString);
      return Array.isArray(parsed.relations) ? parsed.relations : [];
    } catch {
      return [];
    }
  }

  async getAnnotations(itemId: string): Promise<PdfAnnotation[]> {
    const item = await this.findItemById(itemId);
    return this.parseAnnotations(item?.extra ?? null);
  }

  async putAnnotation(
    itemId: string,
    annotation: PdfAnnotation,
  ): Promise<PdfAnnotation[]> {
    const { extraObj } = await this.mutateItemExtra(itemId, (extra) => {
      const list: PdfAnnotation[] = Array.isArray(extra.annotations)
        ? extra.annotations
        : [];
      extra.annotations = [...list, annotation];
      return extra;
    });
    return Array.isArray(extraObj.annotations) ? extraObj.annotations : [];
  }

  async replaceAnnotation(
    itemId: string,
    annotationId: string,
    updates: Partial<Pick<PdfAnnotation, 'comment' | 'color' | 'updatedAt'>>,
  ): Promise<PdfAnnotation | null> {
    let updated: PdfAnnotation | null = null;
    await this.mutateItemExtra(itemId, (extra) => {
      const list: PdfAnnotation[] = Array.isArray(extra.annotations)
        ? extra.annotations
        : [];
      const idx = list.findIndex((a) => a.id === annotationId);
      if (idx === -1) return extra;
      updated = { ...list[idx], ...updates };
      list[idx] = updated;
      extra.annotations = list;
      return extra;
    });
    return updated;
  }

  async removeAnnotation(
    itemId: string,
    annotationId: string,
  ): Promise<number> {
    let remaining = -1;
    await this.mutateItemExtra(itemId, (extra) => {
      const list: PdfAnnotation[] = Array.isArray(extra.annotations)
        ? extra.annotations
        : [];
      const filtered = list.filter((a) => a.id !== annotationId);
      if (filtered.length === list.length) return extra;
      remaining = filtered.length;
      extra.annotations = filtered;
      return extra;
    });
    return remaining;
  }

  async getRelations(itemId: string): Promise<StoredRelation[]> {
    const item = await this.findItemById(itemId);
    return this.parseRelations(item?.extra ?? null);
  }

  async putRelation(
    itemId: string,
    relation: StoredRelation,
  ): Promise<StoredRelation> {
    await this.mutateItemExtra(itemId, (extra) => {
      const list: StoredRelation[] = Array.isArray(extra.relations)
        ? extra.relations.filter(
            (r: StoredRelation) =>
              r.targetPaperId !==
                (relation.targetId || relation.targetPaperId) &&
              r.targetId !== (relation.targetId || relation.targetPaperId),
          )
        : [];
      extra.relations = [...list, relation];
      return extra;
    });
    return relation;
  }

  async removeRelation(itemId: string, targetId: string): Promise<void> {
    await this.mutateItemExtra(itemId, (extra) => {
      if (Array.isArray(extra.relations)) {
        extra.relations = extra.relations.filter(
          (r: StoredRelation) =>
            r.targetPaperId !== targetId &&
            r.targetItemId !== targetId &&
            r.targetId !== targetId,
        );
      }
      return extra;
    });
  }

  async deleteRelation(itemId: string, targetId: string): Promise<void> {
    return this.removeRelation(itemId, targetId);
  }

  async getBulkAnnotations(
    itemIds: string[],
  ): Promise<Map<string, PdfAnnotation[]>> {
    if (itemIds.length === 0) return new Map();
    const items = await this.findItems({ id: { in: itemIds } });
    const result = new Map<string, PdfAnnotation[]>();
    for (const item of items) {
      result.set(item.id, this.parseAnnotations(item.extra ?? null));
    }
    for (const id of itemIds) {
      if (!result.has(id)) result.set(id, []);
    }
    return result;
  }

  async getBulkRelations(
    itemIds: string[],
  ): Promise<Map<string, StoredRelation[]>> {
    if (itemIds.length === 0) return new Map();
    const items = await this.findItems({ id: { in: itemIds } });
    const result = new Map<string, StoredRelation[]>();
    for (const item of items) {
      result.set(item.id, this.parseRelations(item.extra ?? null));
    }
    for (const id of itemIds) {
      if (!result.has(id)) result.set(id, []);
    }
    return result;
  }

  async getAnnotationsBatch(
    itemIds: string[],
  ): Promise<Map<string, PdfAnnotation[]>> {
    return this.getBulkAnnotations(itemIds);
  }

  async getRelationsBatch(
    itemIds: string[],
  ): Promise<Map<string, StoredRelation[]>> {
    return this.getBulkRelations(itemIds);
  }
}
