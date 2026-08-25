import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma } from '@prisma/client';
import { LIBRARY_ITEM_INCLUDE, LibraryItemRecord } from './items/item.types';

export type CatalogItemWithRelations = LibraryItemRecord;

@Injectable()
export class CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prisma.workspace.findFirst({
      where: {
        OR: [{ id: workspaceIdOrSlug }, { url: workspaceIdOrSlug }],
      },
      select: { id: true },
    });
  }

  /**
   * Resolves a workspace ID-or-slug to a canonical string ID.
   * Returns the raw slug unchanged if no workspace record is found (passthrough).
   *
   * Replaces the `const ws = await …; const targetWsId = ws?.id || id;` pattern
   * that was repeated across RelationService (×3), QualityService (×1), and IngestionService (×1).
   */
  async resolveWorkspaceId(workspaceIdOrSlug: string): Promise<string> {
    const ws = await this.resolveWorkspace(workspaceIdOrSlug);
    return ws?.id ?? workspaceIdOrSlug;
  }

  async findItems(
    where: Prisma.CatalogItemWhereInput,
    options?: {
      skip?: number;
      take?: number;
      orderBy?: Prisma.CatalogItemOrderByWithRelationInput[];
    },
  ) {
    return this.prisma.catalogItem.findMany({
      where,
      include: LIBRARY_ITEM_INCLUDE,
      orderBy: options?.orderBy || { createdAt: 'desc' },
      take: options?.take,
      skip: options?.skip,
    });
  }

  async countItems(where: Prisma.CatalogItemWhereInput): Promise<number> {
    return this.prisma.catalogItem.count({ where });
  }

  async countPapers(where: Prisma.CatalogItemWhereInput): Promise<number> {
    return this.countItems(where);
  }

  async findItemById(paperId: string) {
    return this.prisma.catalogItem.findUnique({
      where: { id: paperId },
      include: LIBRARY_ITEM_INCLUDE,
    });
  }

  async findItemByIdInWorkspace(workspaceId: string, itemId: string) {
    return this.prisma.catalogItem.findFirst({
      where: { id: itemId, workspaceId },
      include: LIBRARY_ITEM_INCLUDE,
    });
  }

  /**
   * Finds an existing non-deleted Paper by normalised DOI within a workspace.
   * Used by IngestionService to detect duplicates before calling createItem().
   */
  async findItemByDoi(
    workspaceId: string,
    doi: string,
  ): Promise<CatalogItemWithRelations | null> {
    const paper = await this.prisma.catalogItem.findFirst({
      where: {
        workspaceId,
        deletedAt: null,
        doi: { equals: doi.trim(), mode: 'insensitive' },
      },
      include: LIBRARY_ITEM_INCLUDE,
    });
    return paper ?? null;
  }

  /**
   * @internal — Called only from IngestionService.ingest().
   * Do NOT call this directly from other services; bypassing IngestionService
   * skips citation key generation, DOI deduplication, and metadata enrichment.
   * See ADR-0002: IngestionService is the authoritative Paper creation entry point.
   */
  async createItem(
    data:
      Prisma.CatalogItemCreateInput | Prisma.CatalogItemUncheckedCreateInput,
  ) {
    return this.prisma.catalogItem.create({
      data: data as Prisma.CatalogItemCreateInput,
      include: LIBRARY_ITEM_INCLUDE,
    });
  }

  async updateItem(
    paperId: string,
    data:
      Prisma.CatalogItemUpdateInput | Prisma.CatalogItemUncheckedUpdateInput,
  ) {
    return this.prisma.catalogItem.update({
      where: { id: paperId },
      data: data,
      include: LIBRARY_ITEM_INCLUDE,
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

  /**
   * Deterministically resolve unique citationKey within workspace
   */
  async resolveUniqueCitationKey(
    workspaceId: string,
    baseKey: string,
    excludePaperId?: string,
  ): Promise<string> {
    const existing = await this.prisma.catalogItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        citationKey: {
          startsWith: baseKey,
        },
        ...(excludePaperId && { id: { not: excludePaperId } }),
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

  /**
   * Concurrency-safe atomic mutation for JSON facets stored in paper.extra (annotations, relations, etc.)
   */
  async mutatePaperExtra(
    paperId: string,
    mutator: (
      currentExtra: Record<string, any>,
    ) => Record<string, any> | Promise<Record<string, any>>,
  ): Promise<{
    paper: CatalogItemWithRelations;
    extraObj: Record<string, any>;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const currentPaper = await tx.catalogItem.findUnique({
        where: { id: paperId },
        select: { id: true, extra: true },
      });

      if (!currentPaper) {
        throw new NotFoundException(`Paper with ID ${paperId} not found`);
      }

      let extraObj: Record<string, any> = {};
      if (currentPaper.extra && currentPaper.extra.trim()) {
        try {
          extraObj = JSON.parse(currentPaper.extra);
        } catch {
          extraObj = {};
        }
      }

      const updatedExtraObj = await mutator(extraObj);
      const updatedExtraString = JSON.stringify(updatedExtraObj);

      const paper = await tx.catalogItem.update({
        where: { id: paperId },
        data: { extra: updatedExtraString },
        include: LIBRARY_ITEM_INCLUDE,
      });

      return { paper, extraObj: updatedExtraObj };
    });
  }

  /**
   * Returns all unique Label strings across the workspace using a SQL-level
   * DISTINCT UNNEST — O(n) in SQL instead of fetching up to 1000 Paper records
   * and iterating labels in JS. Sorted ascending.
   */
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

  /**
   * Returns the ID of the first user in the system.
   * Used as a fallback when userId is not yet available at ingestion time.
   * @internal — only call from CatalogService.uploadPaper() fallback path.
   */
  async findFirstUserId(): Promise<string | null> {
    const u = await this.prisma.user.findFirst({ select: { id: true } });
    return u?.id ?? null;
  }

  /**
   * Tier 1 Duplicate Detection — SQL push-down.
   * Groups Papers by their normalised DOI (LOWER + TRIM) and returns only
   * groups with ≥ 2 members. The heavy O(n) JS loop is replaced with a single
   * GROUP BY query whose result set is bounded by the number of duplicate DOIs,
   * not the number of Papers.
   *
   * Returns: array of { doi, paperIds } where paperIds has ≥ 2 elements.
   */
  async findDoiDuplicates(
    workspaceId: string,
  ): Promise<{ doi: string; paperIds: string[] }[]> {
    const rows = await this.prisma.$queryRaw<
      { doi: string; paper_ids: string[] }[]
    >`
      SELECT
        LOWER(TRIM(doi)) AS doi,
        ARRAY_AGG(id ORDER BY created_at ASC) AS paper_ids
      FROM "papers"
      WHERE workspace_id  = ${workspaceId}
        AND deleted_at    IS NULL
        AND doi           IS NOT NULL
        AND TRIM(doi)     != ''
        AND LENGTH(TRIM(doi)) > 3
      GROUP BY LOWER(TRIM(doi))
      HAVING COUNT(*) > 1
    `;
    return rows.map((r) => ({ doi: r.doi, paperIds: r.paper_ids }));
  }

  /**
   * Returns aggregate integrity counts for the workspace in a single SQL round-trip.
   * Used by QualityService.getIntegrityReport() to avoid fetching all Paper records.
   *
   * Note: `missing_pdf` requires joining attachments and cannot be expressed as a simple
   * COUNT aggregate without a subquery — it is still computed in JS from the flagged items list.
   */
  async findIntegrityStats(workspaceId: string): Promise<{
    totalPapers: number;
    missingDoiCount: number;
    missingYearCount: number;
    missingAuthorsCount: number;
  }> {
    const rows = await this.prisma.$queryRaw<
      {
        total_papers: bigint;
        missing_doi: bigint;
        missing_year: bigint;
        missing_authors: bigint;
      }[]
    >`
      SELECT
        COUNT(*)                                                           AS total_papers,
        COUNT(*) FILTER (WHERE doi IS NULL OR TRIM(doi) = '')             AS missing_doi,
        COUNT(*) FILTER (WHERE year IS NULL)                              AS missing_year,
        COUNT(*) FILTER (WHERE authors = '{}' OR authors IS NULL)         AS missing_authors
      FROM "papers"
      WHERE workspace_id = ${workspaceId}
        AND deleted_at IS NULL
    `;
    const r = rows[0] ?? {
      total_papers: 0n,
      missing_doi: 0n,
      missing_year: 0n,
      missing_authors: 0n,
    };
    return {
      totalPapers: Number(r.total_papers),
      missingDoiCount: Number(r.missing_doi),
      missingYearCount: Number(r.missing_year),
      missingAuthorsCount: Number(r.missing_authors),
    };
  }

  /**
   * Atomic 3-step merge transaction for the Safe Merge Protocol.
   *
   * Encapsulates the Prisma transaction so that QualityService does not need
   * to reach through the repository seam into the DB client.
   *
   * Steps:
   *  1. Update master Paper's notes and labels (consolidated from sources).
   *  2. Re-assign all attachments from source Papers to master Paper.
   *  3. Soft-delete all source Papers (deletedAt = now).
   */
  async executeMergePapersTransaction(args: {
    masterId: string;
    sourcePaperIds: string[];
    consolidatedNotes: any[];
    consolidatedLabels: string[];
    now: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 1. Update master paper notes & labels
      await tx.catalogItem.update({
        where: { id: args.masterId },
        data: {
          notes: args.consolidatedNotes as any,
          labels: args.consolidatedLabels,
        },
      });

      // 2. Transfer attachments from sources to master
      await tx.catalogAttachment.updateMany({
        where: { catalogItemId: { in: args.sourcePaperIds } },
        data: { catalogItemId: args.masterId },
      });

      // 3. Soft-delete source papers
      await tx.catalogItem.updateMany({
        where: { id: { in: args.sourcePaperIds } },
        data: { deletedAt: args.now },
      });
    });
  }
}
