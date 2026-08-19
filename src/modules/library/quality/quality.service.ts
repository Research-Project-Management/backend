import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PaperRepository } from '../paper/paper.repository';
import { extractFamilyName } from '../reference/utils/name-parser.util';
import {
  MergePapersDto,
  DuplicateGroup,
  DuplicateGroupItem,
  IntegrityReport,
  IntegrityIssue,
} from './dto/quality.dto';

@Injectable()
export class QualityService {
  private readonly logger = new Logger(QualityService.name);

  constructor(private readonly paperRepo: PaperRepository) {}

  /**
   * 2-Tier Duplicate Detection:
   * Tier 1 (High Confidence): Identical normalized DOI strings.
   * Tier 2 (Medium Confidence): Cleaned Title + Publication Year (+/- 1) + First Author Family Name.
   */
  async getDuplicateGroups(workspaceId: string): Promise<{ duplicateGroups: DuplicateGroup[] }> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const papers = await this.paperRepo.findPapers({
      workspaceId: targetWsId,
      deletedAt: null,
    });

    const duplicateGroups: DuplicateGroup[] = [];
    const processedPaperIds = new Set<string>();

    // Helper: Map paper to DuplicateGroupItem
    const toGroupItem = (p: any): DuplicateGroupItem => ({
      id: p.id,
      title: p.title,
      doi: p.doi || undefined,
      authors: p.authors || [],
      year: p.year || null,
      citationKey: p.citationKey || '',
      collectionId: p.collectionId,
      createdAt: p.createdAt,
      attachmentsCount: p.attachments?.length || 0,
    });

    // Helper: Clean and normalize title
    const normalizeTitle = (title: string): string => {
      return (title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .trim();
    };

    // --- Tier 1: Match by DOI (High Confidence) ---
    const doiMap = new Map<string, typeof papers>();
    for (const paper of papers) {
      if (paper.doi && paper.doi.trim().length > 3) {
        const cleanDoi = paper.doi.trim().toLowerCase();
        const existing = doiMap.get(cleanDoi) || [];
        existing.push(paper);
        doiMap.set(cleanDoi, existing);
      }
    }

    for (const [doi, groupPapers] of doiMap.entries()) {
      if (groupPapers.length > 1) {
        duplicateGroups.push({
          matchType: 'DOI',
          confidence: 'high',
          matchKey: doi,
          papers: groupPapers.map(toGroupItem),
        });
        groupPapers.forEach((p) => processedPaperIds.add(p.id));
      }
    }

    // --- Tier 2: Match by Title + Year (+/- 1) + Author (Medium Confidence) ---
    const remainingPapers = papers.filter((p) => !processedPaperIds.has(p.id));

    for (let i = 0; i < remainingPapers.length; i++) {
      const p1 = remainingPapers[i];
      if (processedPaperIds.has(p1.id)) continue;

      const normTitle1 = normalizeTitle(p1.title);
      if (normTitle1.length < 5) continue;

      const auth1 = p1.authors?.[0] ? extractFamilyName(p1.authors[0]) : '';
      const matchingGroup = [p1];

      for (let j = i + 1; j < remainingPapers.length; j++) {
        const p2 = remainingPapers[j];
        if (processedPaperIds.has(p2.id)) continue;

        const normTitle2 = normalizeTitle(p2.title);
        if (normTitle1 === normTitle2) {
          const auth2 = p2.authors?.[0] ? extractFamilyName(p2.authors[0]) : '';
          const authorMatch = !auth1 || !auth2 || auth1 === auth2;

          let yearMatch = true;
          if (p1.year && p2.year) {
            yearMatch = Math.abs(p1.year - p2.year) <= 1;
          }

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
          papers: matchingGroup.map(toGroupItem),
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
  async mergePapers(
    workspaceId: string,
    userId: string,
    dto: MergePapersDto,
  ) {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    if (!dto.masterPaperId || !dto.sourcePaperIds || dto.sourcePaperIds.length === 0) {
      throw new BadRequestException('Must specify a masterPaperId and at least one sourcePaperId');
    }

    if (dto.sourcePaperIds.includes(dto.masterPaperId)) {
      throw new BadRequestException('Master paper cannot be included in sourcePaperIds');
    }

    const master = await this.paperRepo.findPaperById(dto.masterPaperId);
    if (!master || master.deletedAt || master.workspaceId !== targetWsId) {
      throw new NotFoundException('Master paper not found in this workspace');
    }

    const sources = await this.paperRepo.findPapers({
      id: { in: dto.sourcePaperIds },
      workspaceId: targetWsId,
      deletedAt: null,
    });

    if (sources.length !== dto.sourcePaperIds.length) {
      throw new NotFoundException('One or more source papers could not be found');
    }

    // Consolidate notes and labels
    const consolidatedNotes: Array<{ title: string; content: string }> = Array.isArray(master.notes)
      ? [...(master.notes as any[])]
      : [];

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

    // Execute atomic transaction
    const now = new Date();
    await this.paperRepo.prisma.$transaction(async (tx) => {
      // 1. Update master paper notes & labels
      await tx.paper.update({
        where: { id: master.id },
        data: {
          notes: consolidatedNotes as any,
          labels: Array.from(consolidatedLabels),
        },
      });

      // 2. Transfer attachments from sources to master
      await tx.paperAttachment.updateMany({
        where: {
          paperId: { in: dto.sourcePaperIds },
        },
        data: {
          paperId: master.id,
        },
      });

      // 3. Soft-delete source papers
      await tx.paper.updateMany({
        where: {
          id: { in: dto.sourcePaperIds },
        },
        data: {
          deletedAt: now,
        },
      });
    });

    const updatedMaster = await this.paperRepo.findPaperById(master.id);
    return {
      masterPaper: updatedMaster,
      mergedCount: sources.length,
      softDeletedPaperIds: dto.sourcePaperIds,
    };
  }

  /**
   * Scans library for missing fields and metadata health metrics
   */
  async getIntegrityReport(workspaceId: string): Promise<IntegrityReport> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const papers = await this.paperRepo.findPapers({
      workspaceId: targetWsId,
      deletedAt: null,
    });

    let missingDoiCount = 0;
    let missingYearCount = 0;
    let missingAuthorsCount = 0;
    let missingPdfCount = 0;
    const flaggedItems: IntegrityIssue[] = [];

    for (const p of papers) {
      const issues: string[] = [];

      if (!p.doi || p.doi.trim().length === 0) {
        missingDoiCount++;
        issues.push('Missing DOI identifier');
      }

      if (!p.year) {
        missingYearCount++;
        issues.push('Missing publication year');
      }

      if (!p.authors || p.authors.length === 0) {
        missingAuthorsCount++;
        issues.push('Missing author list');
      }

      const hasPdf = p.fileUrl || (p.attachments as any[])?.some((a: any) => a.mimeType?.includes('pdf') || a.filename?.endsWith('.pdf'));
      if (!hasPdf) {
        missingPdfCount++;
        issues.push('Missing primary PDF attachment');
      }

      if (issues.length > 0) {
        flaggedItems.push({
          paperId: p.id,
          title: p.title,
          citationKey: p.citationKey || '',
          issues,
        });
      }
    }

    return {
      totalPapers: papers.length,
      healthyPapers: papers.length - flaggedItems.length,
      missingDoiCount,
      missingYearCount,
      missingAuthorsCount,
      missingPdfCount,
      flaggedItems,
    };
  }
}
