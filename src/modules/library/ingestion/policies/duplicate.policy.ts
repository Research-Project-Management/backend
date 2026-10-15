import { ItemMetadata } from '@/modules/library/ingestion/types/metadata.types';
import { DuplicateMatchResult } from '@/modules/library/ingestion/types/metadata-candidate.types';
import { normalizeDoi } from '@/modules/library/shared-kernel/domain/bibliographic.domain';
import {
  calculateTitleSimilarity,
  firstAuthorMatches,
} from '@/modules/library/ingestion/domain/deduplication.domain';

export interface ExistingItemSummary {
  id: string;
  title: string;
  doi?: string | null;
  year?: number | null;
  authors?: string[];
  citationKey?: string | null;
}

export class DuplicatePolicy {
  /**
   * Matches proposed metadata against existing workspace items.
   */
  evaluate(
    proposed: ItemMetadata,
    existingItems: ExistingItemSummary[],
  ): DuplicateMatchResult {
    const cleanProposedDoi =
      normalizeDoi(proposed.doi) || proposed.doi?.toLowerCase().trim();

    // 1. Exact DOI match
    if (cleanProposedDoi) {
      const exactDoiMatch = existingItems.find((it) => {
        if (!it.doi) return false;
        const cleanExistingDoi =
          normalizeDoi(it.doi) || it.doi.toLowerCase().trim();
        return cleanExistingDoi === cleanProposedDoi;
      });
      if (exactDoiMatch) {
        return {
          matchType: 'EXACT',
          confidence: 1.0,
          targetItemId: exactDoiMatch.id,
          targetItemTitle: exactDoiMatch.title,
          matchReason: 'DOI_EXACT',
          evidence: { doi: cleanProposedDoi },
        };
      }
    }

    // 2. Probable match by Title and Year / Authors
    if (proposed.title && proposed.title.trim().length > 5) {
      for (const item of existingItems) {
        if (!item.title) continue;
        const similarity = calculateTitleSimilarity(proposed.title, item.title);
        if (similarity >= 0.88) {
          // Same title! Check secondary signals (year within +/-1 or first author)
          const yearMatch =
            proposed.year &&
            item.year &&
            Math.abs(Number(proposed.year) - Number(item.year)) <= 1;
          const authorMatch =
            proposed.authors &&
            proposed.authors.length > 0 &&
            item.authors &&
            item.authors.length > 0 &&
            firstAuthorMatches(proposed.authors[0], item.authors[0]);

          if (yearMatch || authorMatch) {
            return {
              matchType: 'PROBABLE',
              confidence: 0.85,
              targetItemId: item.id,
              targetItemTitle: item.title,
              matchReason: 'TITLE_FUZZY',
              evidence: {
                proposedTitle: proposed.title,
                existingTitle: item.title,
                yearMatch: Boolean(yearMatch),
                authorMatch: Boolean(authorMatch),
              },
            };
          }
        }
      }
    }

    return {
      matchType: 'NO_MATCH',
      confidence: 0.0,
      matchReason: 'NONE',
    };
  }
}
