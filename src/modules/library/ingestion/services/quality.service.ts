import { Injectable, Inject, Optional } from '@nestjs/common';
import { CATALOG_FACADE, ICatalogFacade } from '@/modules/library/core';
import { DuplicateService } from './duplicate.service';
import { ItemsMapper } from '@/modules/library/catalog';

export interface CompletenessAnalysis {
  score: number; // 0 - 100
  level: 'complete' | 'adequate' | 'minimal';
  missingKeyFields: string[];
  presentFieldsCount: number;
  totalFieldsCount: number;
}

export interface QualityAuditReport {
  totalItems: number;
  averageQualityScore: number;
  healthReport: {
    missingDoi: number;
    missingAbstract: number;
    missingYear: number;
  };
}

@Injectable()
export class QualityService {
  constructor(
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    private readonly duplicateService?: DuplicateService,
  ) {}

  /**
   * Calculates completeness score for an item based on its type definition.
   */
  calculateItemCompleteness(
    item: Record<string, unknown>,
  ): CompletenessAnalysis {
    const itemType =
      typeof item.itemType === 'string'
        ? item.itemType
        : typeof item.type === 'string'
          ? item.type
          : 'journalArticle';
    const fields = this.catalogGateway?.getOrderedFields
      ? this.catalogGateway.getOrderedFields(itemType)
      : [];

    if (!fields || fields.length === 0) {
      return {
        score: 50,
        level: 'adequate',
        missingKeyFields: [],
        presentFieldsCount: 1,
        totalFieldsCount: 1,
      };
    }

    const missingKeyFields: string[] = [];
    let presentCount = 0;
    let totalScore = 0;

    // Check title (Core: 25 pts)
    const hasTitle = Boolean(
      typeof item.title === 'string' && item.title.trim().length > 0,
    );
    if (hasTitle) {
      totalScore += 25;
      presentCount++;
    } else {
      missingKeyFields.push('title');
    }

    // Check creators / authors (Core: 25 pts)
    const hasCreators = Boolean(
      (Array.isArray(item.creators) && item.creators.length > 0) ||
      (Array.isArray(item.authors) && item.authors.length > 0) ||
      (Array.isArray(item.contributors) && item.contributors.length > 0),
    );
    if (hasCreators) {
      totalScore += 25;
      presentCount++;
    } else {
      missingKeyFields.push('authors');
    }

    // Check date / year (Core: 15 pts)
    const hasDate = Boolean(item.year || item.publicationDate || item.date);
    if (hasDate) {
      totalScore += 15;
      presentCount++;
    } else {
      missingKeyFields.push('year');
    }

    // Check identifier (DOI, ISBN, Arxiv, PMID, URL) (Identifying: 15 pts)
    const hasIdentifier = Boolean(
      item.doi ||
      item.isbn ||
      item.issn ||
      item.arxivId ||
      item.pmid ||
      item.url,
    );
    if (hasIdentifier) {
      totalScore += 15;
      presentCount++;
    } else {
      missingKeyFields.push('identifier');
    }

    // Check context (publicationTitle, journal, publisher, abstract) (Context: 15 pts)
    const hasContext = Boolean(
      item.publicationTitle ||
      item.journal ||
      item.publisher ||
      item.bookTitle ||
      item.proceedingsTitle,
    );
    if (hasContext) {
      totalScore += 10;
      presentCount++;
    }

    const hasAbstract = Boolean(item.abstract || item.abstractNote);
    if (hasAbstract) {
      totalScore += 5;
      presentCount++;
    } else {
      missingKeyFields.push('abstract');
    }

    // Check type-specific completeness
    let extraFields: Record<string, unknown> = {};
    if (item.extraFields && typeof item.extraFields === 'object') {
      extraFields = item.extraFields as Record<string, unknown>;
    } else if (
      typeof item.extra === 'string' &&
      item.extra.trim().startsWith('{')
    ) {
      try {
        extraFields = JSON.parse(item.extra) as Record<string, unknown>;
      } catch {
        // ignore
      }
    }

    const typeSpecificKeys = (fields as Array<{ key: string }>)
      .filter((f) => !['title', 'date', 'url', 'doi'].includes(f.key))
      .slice(0, 5)
      .map((f) => f.key);

    const hasTypeSpecific = typeSpecificKeys.some(
      (k: string) => Boolean(item[k]) || Boolean(extraFields[k]),
    );
    if (hasTypeSpecific) {
      totalScore += 5;
      presentCount++;
    }

    const finalScore = Math.min(100, Math.max(0, totalScore));
    let level: 'complete' | 'adequate' | 'minimal' = 'minimal';
    if (finalScore >= 80) level = 'complete';
    else if (finalScore >= 50) level = 'adequate';

    return {
      score: finalScore,
      level,
      missingKeyFields,
      presentFieldsCount: presentCount,
      totalFieldsCount: fields.length,
    };
  }

  async getQualityAudit(userId: string, projectId?: string) {
    const items = this.catalogGateway
      ? await this.catalogGateway.findQualityAuditItems(userId, 2000, projectId)
      : [];

    let totalScore = 0;
    let missingDoi = 0;
    let missingAbstract = 0;
    let missingYear = 0;
    let missingAuthors = 0;
    let healthyItems = 0;
    const flaggedItems: Array<{
      itemId: string;
      paperId: string;
      title: string;
      issues: string[];
    }> = [];

    for (const it of items) {
      let score = 0;
      const issues: string[] = [];

      if (it.title && it.title.length > 3) score += 25;
      else issues.push('missing_title');

      if (it.contributors && it.contributors.length > 0) score += 25;
      else {
        missingAuthors += 1;
        issues.push('missing_authors');
      }

      if (it.year && it.year > 1900) score += 20;
      else {
        missingYear += 1;
        issues.push('missing_year');
      }

      if (it.doi) score += 15;
      else {
        missingDoi += 1;
        issues.push('missing_doi');
      }

      if (it.abstract) score += 15;
      else {
        missingAbstract += 1;
        issues.push('missing_abstract');
      }

      if (issues.length === 0) {
        healthyItems += 1;
      } else {
        flaggedItems.push({
          itemId: it.id,
          paperId: it.id,
          title: it.title || 'Untitled',
          issues,
        });
      }

      totalScore += score;
    }

    const averageQualityScore =
      items.length > 0 ? Math.round(totalScore / items.length) : 100;

    return {
      totalItems: items.length,
      totalPapers: items.length,
      healthyItems,
      healthyPapers: healthyItems,
      averageQualityScore,
      healthScorePercentage: averageQualityScore,
      missingDoiCount: missingDoi,
      missingYearCount: missingYear,
      missingAuthorsCount: missingAuthors,
      missingAbstractCount: missingAbstract,
      missingPdfCount: 0,
      flaggedItems,
      healthReport: {
        missingDoi,
        missingAbstract,
        missingYear,
      },
    };
  }

  /**
   * Retrieves duplicate groups with preserved recommendedMasterId and full domain-projected items
   * (papers & items) so consumers never need N+1 GET /library/items/:id calls.
   */
  async getDuplicates(userId: string, projectId?: string) {
    const rawClusters = this.duplicateService
      ? await this.duplicateService.detectDuplicates(userId, projectId)
      : [];

    const duplicateGroups = rawClusters.map((cluster) => {
      const domainItems = (cluster.items || []).map((it) =>
        ItemsMapper.toDomain(it),
      );
      return {
        key: cluster.clusterId,
        clusterId: cluster.clusterId,
        matchType:
          cluster.matchReason === 'EXACT_DOI'
            ? ('DOI' as const)
            : ('TITLE_AUTHOR_YEAR' as const),
        matchReason: cluster.matchReason,
        confidence:
          cluster.confidence >= 1 ? ('high' as const) : ('medium' as const),
        confidenceScore: cluster.confidence,
        recommendedMasterId: cluster.recommendedMasterId,
        papers: domainItems,
        items: domainItems,
      };
    });

    return {
      duplicateGroups,
      clusters: rawClusters,
      totalDuplicates: duplicateGroups.reduce(
        (acc, g) => acc + (g.papers?.length || 0),
        0,
      ),
    };
  }
}
