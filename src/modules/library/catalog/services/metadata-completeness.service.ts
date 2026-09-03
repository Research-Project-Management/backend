import { Injectable, Logger } from '@nestjs/common';
import { ItemTypeRegistryService } from '../registry/item-type-registry.service';

export interface CompletenessAnalysis {
  score: number; // 0 - 100
  level: 'complete' | 'adequate' | 'minimal';
  missingKeyFields: string[];
  presentFieldsCount: number;
  totalFieldsCount: number;
}

@Injectable()
export class MetadataCompletenessService {
  private readonly logger = new Logger(MetadataCompletenessService.name);

  constructor(private readonly registryService: ItemTypeRegistryService) {}

  /**
   * Calculates completeness score for a catalog item based on its type definition.
   */
  calculateItemCompleteness(item: Record<string, any>): CompletenessAnalysis {
    const itemType = item.itemType || item.type || 'journalArticle';
    const fields = this.registryService.getOrderedFields(itemType);

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
      (Array.isArray(item.authors) && item.authors.length > 0),
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
    }

    // Check type-specific fields (5 pts)
    const extraFields = item.extraFields || {};
    const typeSpecificKeys = fields
      .filter((f) => f.category !== 'core' && f.category !== 'identifiers')
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
}
