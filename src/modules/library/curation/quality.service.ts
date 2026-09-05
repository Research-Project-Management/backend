import { Injectable, Logger } from '@nestjs/common';
import { TypesService } from '../types/types.service';
import { PrismaService } from '../../../core/database/prisma.service';

export interface CompletenessAnalysis {
  score: number; // 0 - 100
  level: 'complete' | 'adequate' | 'minimal';
  missingKeyFields: string[];
  presentFieldsCount: number;
  totalFieldsCount: number;
}

@Injectable()
export class QualityService {
  private readonly logger = new Logger(QualityService.name);

  constructor(
    private readonly typesService: TypesService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Calculates completeness score for an item based on its type definition.
   */
  calculateItemCompleteness(item: Record<string, any>): CompletenessAnalysis {
    const itemType = item.itemType || item.type || 'journalArticle';
    const fields = this.typesService.getOrderedFields(itemType);

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
      item.title && String(item.title).trim().length > 0,
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
    let extraFields: Record<string, any> = {};
    if (item.extraFields && typeof item.extraFields === 'object') {
      extraFields = item.extraFields;
    } else if (
      typeof item.extra === 'string' &&
      item.extra.trim().startsWith('{')
    ) {
      try {
        extraFields = JSON.parse(item.extra);
      } catch {
        // ignore
      }
    }

    const typeSpecificKeys = fields
      .filter((f) => !['title', 'date', 'url', 'doi'].includes(f.key))
      .slice(0, 5)
      .map((f) => f.key);

    const hasTypeSpecific = typeSpecificKeys.some(
      (k) => Boolean(item[k]) || Boolean(extraFields[k]),
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

  async getQualityAudit(workspaceId: string) {
    const items = await this.prisma.catalogItem.findMany({
      where: { workspaceId, deletedAt: null },
      select: {
        id: true,
        title: true,
        doi: true,
        abstract: true,
        year: true,
        contributors: {
          where: { creatorType: 'author' },
          select: { id: true },
        },
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
      if (it.contributors && it.contributors.length > 0) score += 25;
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

export const MetadataCompletenessService = QualityService;
export type MetadataCompletenessService = QualityService;
