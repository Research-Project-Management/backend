import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { LibraryTransactionService } from '../sync-core/library-transaction.service';
import { CatalogService } from '../catalog/catalog.service';
import { MergeDuplicatesDto, DuplicateClusterResult } from './dto/curation.dto';

@Injectable()
export class CurationService {
  private readonly logger = new Logger(CurationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly libraryTx: LibraryTransactionService,
    private readonly catalogService: CatalogService,
  ) {}

  /**
   * Scans active items in workspace and clusters duplicate candidates.
   */
  async detectDuplicates(
    workspaceId: string,
  ): Promise<DuplicateClusterResult[]> {
    const items = await this.prisma.catalogItem.findMany({
      where: { workspaceId, deletedAt: null },
      select: {
        id: true,
        title: true,
        doi: true,
        citationKey: true,
        year: true,
        authors: true,
      },
    });

    const clusters: DuplicateClusterResult[] = [];
    const doiMap = new Map<string, typeof items>();
    const titleMap = new Map<string, typeof items>();

    // 1. Group by exact DOI
    for (const item of items) {
      if (item.doi && item.doi.trim()) {
        const cleanDoi = item.doi.trim().toLowerCase();
        const list = doiMap.get(cleanDoi) || [];
        list.push(item);
        doiMap.set(cleanDoi, list);
      }
    }

    doiMap.forEach((matched, doi) => {
      if (matched.length > 1) {
        clusters.push({
          clusterId: `doi-${doi}`,
          matchReason: 'EXACT_DOI',
          confidence: 1.0,
          items: matched.map((m) => ({
            id: m.id,
            title: m.title,
            doi: m.doi ?? undefined,
            year: m.year ?? undefined,
            authors: m.authors,
          })),
        });
      }
    });

    // 2. Group by normalized title
    for (const item of items) {
      const normTitle = item.title
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .trim();

      if (normTitle.length > 10) {
        const list = titleMap.get(normTitle) || [];
        list.push(item);
        titleMap.set(normTitle, list);
      }
    }

    titleMap.forEach((matched, title) => {
      if (matched.length > 1) {
        // Skip if already in DOI cluster
        const itemIds = matched.map((m) => m.id);
        const alreadyClustered = clusters.some((c) =>
          c.items.some((it) => itemIds.includes(it.id)),
        );

        if (!alreadyClustered) {
          clusters.push({
            clusterId: `title-${title.substring(0, 16)}`,
            matchReason: 'NORMALIZED_TITLE',
            confidence: 0.85,
            items: matched.map((m) => ({
              id: m.id,
              title: m.title,
              doi: m.doi ?? undefined,
              year: m.year ?? undefined,
              authors: m.authors,
            })),
          });
        }
      }
    });

    return clusters;
  }

  /**
   * Non-destructive merge of duplicate items into a primary item atomically.
   */
  async mergeDuplicates(workspaceId: string, dto: MergeDuplicatesDto) {
    const primary = await this.prisma.catalogItem.findUnique({
      where: { id: dto.primaryItemId },
    });
    if (!primary || primary.workspaceId !== workspaceId) {
      throw new NotFoundException(
        `Primary item ${dto.primaryItemId} not found`,
      );
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      // 1. Move attachments and relations to primary item
      for (const dupId of dto.duplicateItemIds) {
        if (dupId === dto.primaryItemId) continue;

        // Reassign attachments
        await tx.catalogAttachment.updateMany({
          where: { catalogItemId: dupId },
          data: { catalogItemId: dto.primaryItemId },
        });

        // Soft-delete duplicate item
        await tx.catalogItem.update({
          where: { id: dupId },
          data: { deletedAt: new Date() },
        });

        // Record tombstone and outbox
        await helpers.recordTombstone(workspaceId, {
          entityType: 'CatalogItem',
          entityId: dupId,
        });

        await helpers.publishOutbox(
          workspaceId,
          dupId,
          'library.item.merged_into',
          { duplicateId: dupId, primaryId: dto.primaryItemId },
        );
      }

      // 2. Update primary item if merged data was supplied
      let updatedPrimary = primary;
      if (dto.mergedData && Object.keys(dto.mergedData).length > 0) {
        updatedPrimary = await tx.catalogItem.update({
          where: { id: dto.primaryItemId },
          data: {
            ...dto.mergedData,
            version: { increment: 1 },
          },
        });

        await helpers.appendChange(workspaceId, {
          entityType: 'CatalogItem',
          entityId: updatedPrimary.id,
          action: 'update',
          version: updatedPrimary.version,
          data: updatedPrimary,
        });
      }

      return updatedPrimary;
    });
  }

  /**
   * Evaluates library metadata completeness and quality metrics.
   */
  async getQualityAudit(workspaceId: string) {
    const items = await this.prisma.catalogItem.findMany({
      where: { workspaceId, deletedAt: null },
      select: {
        id: true,
        title: true,
        doi: true,
        abstract: true,
        year: true,
        authors: true,
        publicationTitle: true,
      },
    });

    let totalScore = 0;
    let missingDoi = 0;
    let missingAbstract = 0;
    let missingYear = 0;

    for (const it of items) {
      let score = 0;
      if (it.title && it.title.length > 3) score += 25;
      if (it.authors && it.authors.length > 0) score += 25;
      if (it.year && it.year > 1900) score += 20;
      else missingYear += 1;
      if (it.doi) score += 15;
      else missingDoi += 1;
      if (it.abstract) score += 15;
      else missingAbstract += 1;

      totalScore += score;
    }

    const averageQualityScore =
      items.length > 0 ? Math.round(totalScore / items.length) : 100;

    return {
      totalItems: items.length,
      averageQualityScore,
      healthReport: {
        missingDoi,
        missingAbstract,
        missingYear,
      },
    };
  }
}
