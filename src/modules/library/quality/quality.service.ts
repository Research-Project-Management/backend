import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { CatalogRepository } from '../catalog/catalog.repository';
import { extractFamilyName } from '../citation/citation.util';
import {
  MergePapersDto,
  DuplicateGroup,
  DuplicateGroupItem,
  IntegrityReport,
  IntegrityIssue,
} from './dto/quality.dto';
import { normalizeQualityTitle } from './quality.util';

@Injectable()
export class QualityService {
  private readonly logger = new Logger(QualityService.name);

  /**
   * Maximum number of papers scanned for the flagged-items list in getIntegrityReport().
   * Capped to prevent OOM on large workspaces; the aggregate summary counts (DOI, Year, Authors)
   * are always exact (SQL aggregates), only the per-paper issue list is capped.
   */
  private readonly MAX_INTEGRITY_ITEMS = 200;

  constructor(private readonly catalogRepo: CatalogRepository) {}

  /**
   * 2-Tier Duplicate Detection:
   * - Tier 1 (High Confidence): SQL GROUP BY normalised DOI — O(1) round-trip.
   * - Tier 2 (Medium Confidence): Cleaned Title + Year (±1) + First Author Family Name.
   *   Only runs on Papers not already grouped in Tier 1.
   */
  async getDuplicateGroups(
    workspaceId: string,
  ): Promise<{ duplicateGroups: DuplicateGroup[] }> {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    const duplicateGroups: DuplicateGroup[] = [];
    const processedPaperIds = new Set<string>();

    // --- Tier 1: SQL GROUP BY normalised DOI (High Confidence) ---
    const doiGroups = await this.catalogRepo.findDoiDuplicates(targetWsId);

    // Collect all duplicated IDs so we can fetch full Paper records in one query
    const tier1Ids = doiGroups.flatMap((g) => g.paperIds);

    if (tier1Ids.length > 0) {
      const tier1Papers = await this.catalogRepo.findItems({
        id: { in: tier1Ids },
        workspaceId: targetWsId,
        deletedAt: null,
      });
      const paperById = new Map(tier1Papers.map((p) => [p.id, p]));

      for (const group of doiGroups) {
        const groupPapers = group.paperIds
          .map((id) => paperById.get(id))
          .filter((p): p is NonNullable<typeof p> => p !== undefined);

        if (groupPapers.length > 1) {
          duplicateGroups.push({
            matchType: 'DOI',
            confidence: 'high',
            matchKey: group.doi,
            items: groupPapers.map((p) => this.toGroupItem(p)),
            papers: groupPapers.map((p) => this.toGroupItem(p)),
          });
          groupPapers.forEach((p) => processedPaperIds.add(p.id));
        }
      }
    }

    // --- Tier 2: Title + Year (±1) + Author (Medium Confidence) ---
    // Only fetch Papers not already in a Tier 1 group
    const allPapers = await this.catalogRepo.findItems({
      workspaceId: targetWsId,
      deletedAt: null,
      ...(processedPaperIds.size > 0 && {
        NOT: { id: { in: Array.from(processedPaperIds) } },
      }),
    });

    const MAX_TIER2_PAPERS = 500;
    let scanPapers = allPapers;
    if (allPapers.length > MAX_TIER2_PAPERS) {
      this.logger.warn(
        `Workspace ${targetWsId} has ${allPapers.length} papers. Capping Tier 2 fuzzy duplicate scan to ${MAX_TIER2_PAPERS} items to prevent event-loop starvation.`,
      );
      scanPapers = allPapers.slice(0, MAX_TIER2_PAPERS);
    }

    for (let i = 0; i < scanPapers.length; i++) {
      const p1 = scanPapers[i];
      if (processedPaperIds.has(p1.id)) continue;

      const normTitle1 = normalizeQualityTitle(p1.title);
      if (normTitle1.length < 5) continue;

      const auth1 = p1.authors?.[0] ? extractFamilyName(p1.authors[0]) : '';
      const matchingGroup = [p1];

      for (let j = i + 1; j < scanPapers.length; j++) {
        const p2 = scanPapers[j];
        if (processedPaperIds.has(p2.id)) continue;

        const normTitle2 = normalizeQualityTitle(p2.title);
        if (normTitle1 === normTitle2) {
          const auth2 = p2.authors?.[0] ? extractFamilyName(p2.authors[0]) : '';
          const authorMatch = !auth1 || !auth2 || auth1 === auth2;
          const yearMatch =
            !p1.year || !p2.year || Math.abs(p1.year - p2.year) <= 1;

          if (authorMatch && yearMatch) {
            matchingGroup.push(p2);
          }
        }
      }

      if (matchingGroup.length > 1) {
        duplicateGroups.push({
          matchType: 'TITLE_AUTHOR_YEAR',
          confidence: 'medium',
          matchKey: `${normTitle1.slice(0, 30)}_${p1.year || 'noyear'}`,
          items: matchingGroup.map((p) => this.toGroupItem(p)),
          papers: matchingGroup.map((p) => this.toGroupItem(p)),
        });
        matchingGroup.forEach((p) => processedPaperIds.add(p.id));
      }
    }

    return { duplicateGroups };
  }

  /**
   * Safe Merge Protocol:
   * 1. Consolidates notes and labels from all source papers into master paper.
   * 2. Re-assigns all attachments from source papers to master paper.
   * 3. Soft-deletes source papers (deletedAt = now()).
   */
  async mergePapers(workspaceId: string, userId: string, dto: MergePapersDto) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    if (
      !(dto.masterId || dto.masterPaperId || '') ||
      !(dto.sourceItemIds || dto.sourcePaperIds || []) ||
      (dto.sourceItemIds || dto.sourcePaperIds || []).length === 0
    ) {
      throw new BadRequestException(
        'Must specify a masterPaperId and at least one sourcePaperId',
      );
    }

    if (
      (dto.sourceItemIds || dto.sourcePaperIds || []).includes(
        dto.masterId || dto.masterPaperId || '',
      )
    ) {
      throw new BadRequestException(
        'Master paper cannot be included in sourcePaperIds',
      );
    }

    const master = await this.catalogRepo.findItemById(
      dto.masterId || dto.masterPaperId || '',
    );
    if (!master || master.deletedAt || master.workspaceId !== targetWsId) {
      throw new NotFoundException('Master paper not found in this workspace');
    }

    const sources = await this.catalogRepo.findItems({
      id: { in: dto.sourceItemIds || dto.sourcePaperIds || [] },
      workspaceId: targetWsId,
      deletedAt: null,
    });

    if (
      sources.length !== (dto.sourceItemIds || dto.sourcePaperIds || []).length
    ) {
      throw new NotFoundException(
        'One or more source papers could not be found',
      );
    }

    // Consolidate notes and labels
    const consolidatedNotes: Array<{ title: string; content: string }> =
      Array.isArray(master.notes) ? [...(master.notes as any[])] : [];

    const consolidatedLabels = new Set<string>(master.labels || []);

    for (const src of sources) {
      if (Array.isArray(src.notes)) {
        for (const note of src.notes as any[]) {
          consolidatedNotes.push(note);
        }
      }
      if (Array.isArray(src.labels)) {
        src.labels.forEach((lbl) => consolidatedLabels.add(lbl));
      }
    }

    // Execute atomic transaction via repository seam (no direct Prisma access from service layer)
    const now = new Date();
    await this.catalogRepo.executeMergePapersTransaction({
      masterId: master.id,
      sourcePaperIds: dto.sourceItemIds || dto.sourcePaperIds || [],
      consolidatedNotes,
      consolidatedLabels: Array.from(consolidatedLabels),
      now,
    });

    // Consolidate citation keys into master extra for citation identity preservation
    const sourceCitationKeys = sources
      .map((s) => s.citationKey)
      .filter(
        (k): k is string => Boolean(k?.trim() && k !== master.citationKey),
      );

    if (sourceCitationKeys.length > 0) {
      await this.catalogRepo.mutatePaperExtra(master.id, (extra) => {
        const existingAliases: string[] = Array.isArray(extra.mergedCitationKeys)
          ? extra.mergedCitationKeys
          : [];
        extra.mergedCitationKeys = Array.from(
          new Set([...existingAliases, ...sourceCitationKeys]),
        );
        return extra;
      });
    }

    const updatedMaster = await this.catalogRepo.findItemById(master.id);
    return {
      masterPaper: updatedMaster,
      mergedCount: sources.length,
      softDeletedPaperIds: dto.sourceItemIds || dto.sourcePaperIds || [],
    };
  }

  /**
   * Scans library for missing fields and metadata health metrics.
   * Aggregate counts (DOI, Year, Authors) use a single SQL round-trip via findIntegrityStats().
   * Flagged items list is capped at 200 to prevent OOM on large workspaces.
   */
  async getIntegrityReport(workspaceId: string): Promise<IntegrityReport> {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    // SQL aggregates — O(1) round-trip for summary counts
    const stats = await this.catalogRepo.findIntegrityStats(targetWsId);

    // Flagged items list — limited to MAX_INTEGRITY_ITEMS to prevent OOM; PDF check requires attachment join
    const flaggedPapers = await this.catalogRepo.findItems(
      { workspaceId: targetWsId, deletedAt: null },
      { take: this.MAX_INTEGRITY_ITEMS, orderBy: [{ createdAt: 'desc' }] },
    );

    const flaggedItems: IntegrityIssue[] = [];

    for (const p of flaggedPapers) {
      const issues: string[] = [];

      if (!p.doi || p.doi.trim().length === 0) {
        issues.push('Missing DOI identifier');
      }
      if (!p.year) {
        issues.push('Missing publication year');
      }
      if (!p.authors || p.authors.length === 0) {
        issues.push('Missing author list');
      }

      const hasPdf =
        p.fileUrl ||
        (p.attachments as any[])?.some(
          (a: any) =>
            a.mimeType?.includes('pdf') || a.filename?.endsWith('.pdf'),
        );
      if (!hasPdf) {
        issues.push('Missing primary PDF attachment');
      }

      if (issues.length > 0) {
        flaggedItems.push({
          itemId: p.id,
          paperId: p.id,
          title: p.title,
          citationKey: p.citationKey || '',
          issues,
        });
      }
    }

    const totalItems = stats.totalPapers || 0;
    const unhealthyCount =
      typeof stats.unhealthyCount === 'number'
        ? stats.unhealthyCount
        : flaggedItems.length;
    const healthyItems = Math.max(0, totalItems - unhealthyCount);
    const missingPdfCount =
      typeof stats.missingPdfCount === 'number'
        ? stats.missingPdfCount
        : flaggedItems.filter((f) =>
            f.issues.includes('Missing primary PDF attachment'),
          ).length;

    return {
      totalItems,
      healthyItems,
      totalPapers: totalItems,
      healthyPapers: healthyItems,
      missingDoiCount: stats.missingDoiCount || 0,
      missingYearCount: stats.missingYearCount || 0,
      missingAuthorsCount: stats.missingAuthorsCount || 0,
      missingPdfCount,
      flaggedItems,
    };
  }

  async getMissingMetadata(workspaceId: string) {
    const report = await this.getIntegrityReport(workspaceId);
    const metadataIssues = new Set([
      'Missing DOI identifier',
      'Missing publication year',
      'Missing author list',
    ]);
    const items = report.flaggedItems
      .map((item) => ({
        ...item,
        issues: item.issues.filter((issue) => metadataIssues.has(issue)),
      }))
      .filter((item) => item.issues.length > 0);

    return {
      total: items.length,
      missingDoiCount: report.missingDoiCount,
      missingYearCount: report.missingYearCount,
      missingAuthorsCount: report.missingAuthorsCount,
      items,
    };
  }

  async getMissingAttachments(workspaceId: string) {
    const report = await this.getIntegrityReport(workspaceId);
    const issue = 'Missing primary PDF attachment';
    const items = report.flaggedItems
      .map((item) => ({
        ...item,
        issues: item.issues.filter((candidate) => candidate === issue),
      }))
      .filter((item) => item.issues.length > 0);

    return {
      total: items.length,
      missingPdfCount: report.missingPdfCount,
      items,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private toGroupItem(p: any): DuplicateGroupItem {
    return {
      id: p.id,
      title: p.title,
      doi: p.doi || undefined,
      authors: p.authors || [],
      year: p.year || null,
      citationKey: p.citationKey || '',
      collectionId: p.collectionId,
      createdAt: p.createdAt,
      attachmentsCount: p.attachments?.length || 0,
    };
  }
}
