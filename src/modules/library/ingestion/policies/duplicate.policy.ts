import { Injectable } from '@nestjs/common';
import { ItemMetadata } from '../metadata/types/metadata.types';
import { DuplicateMatchResult } from '../types/metadata-candidate.types';
import { normalizeDoi } from '../metadata/utils/metadata.utils';

export interface ExistingCatalogItemSummary {
  id: string;
  title: string;
  doi?: string | null;
  year?: number | null;
  authors?: string[];
  citationKey?: string | null;
}

@Injectable()
export class DuplicatePolicy {
  /**
   * Matches proposed metadata against existing workspace items.
   */
  evaluate(
    proposed: ItemMetadata,
    existingItems: ExistingCatalogItemSummary[],
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
    const proposedTitle = this.normalizeTitle(proposed.title);
    if (proposedTitle && proposedTitle.length > 5) {
      for (const item of existingItems) {
        const itemTitle = this.normalizeTitle(item.title);
        if (
          itemTitle &&
          this.calculateTitleSimilarity(proposedTitle, itemTitle) > 0.9
        ) {
          // Same title! Check secondary signals (year or first author)
          const yearMatch =
            proposed.year && item.year && proposed.year === item.year;
          const authorMatch =
            proposed.authors &&
            proposed.authors.length > 0 &&
            item.authors &&
            item.authors.length > 0 &&
            this.firstAuthorMatches(proposed.authors[0], item.authors[0]);

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

  private normalizeTitle(title?: string | null): string {
    if (!title) return '';
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private calculateTitleSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    if (a.includes(b) || b.includes(a)) return 0.92;
    const wordsA = new Set(a.split(' '));
    const wordsB = new Set(b.split(' '));
    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 ? intersection / union : 0.0;
  }

  private firstAuthorMatches(a: string, b: string): boolean {
    const normA = a.toLowerCase().replace(/[^a-z]/g, '');
    const normB = b.toLowerCase().replace(/[^a-z]/g, '');
    return normA.includes(normB) || normB.includes(normA);
  }
}
