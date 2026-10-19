import { Injectable, Inject, Optional } from '@nestjs/common';
import { CATALOG_FACADE, ICatalogFacade } from '@/modules/library/core';
import { calculateMetadataQualityScore } from '@/modules/library/ingestion/domain/metadata.validator';

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

    const typeSpecificKeys = (fields as Array<{ key: string }>)
      .filter((f) => !['title', 'date', 'url', 'doi'].includes(f.key))
      .slice(0, 5)
      .map((f) => f.key);

    const evaluation = calculateMetadataQualityScore(item, {
      typeSpecificKeys,
    });

    return {
      score: evaluation.score,
      level: evaluation.level,
      missingKeyFields: evaluation.missingKeyFields,
      presentFieldsCount: evaluation.presentFieldsCount,
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
      title: string;
      issues: string[];
    }> = [];

    for (const it of items) {
      const evaluation = calculateMetadataQualityScore(
        it as unknown as Record<string, unknown>,
      );
      const issues: string[] = [];

      if (!evaluation.hasTitle || (it.title && it.title.length <= 3)) {
        issues.push('missing_title');
      }
      if (!evaluation.hasAuthors) {
        missingAuthors += 1;
        issues.push('missing_authors');
      }
      if (!evaluation.hasYear || (it.year && it.year <= 1900)) {
        missingYear += 1;
        issues.push('missing_year');
      }
      if (!evaluation.hasDoi) {
        missingDoi += 1;
        issues.push('missing_doi');
      }
      if (!evaluation.hasAbstract) {
        missingAbstract += 1;
        issues.push('missing_abstract');
      }

      if (issues.length === 0) {
        healthyItems += 1;
      } else {
        flaggedItems.push({
          itemId: it.id,
          title: it.title || 'Untitled',
          issues,
        });
      }

      totalScore += evaluation.score;
    }

    const averageQualityScore =
      items.length > 0 ? Math.round(totalScore / items.length) : 100;

    return {
      totalItems: items.length,
      healthyItems,
      averageQualityScore,
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
}

