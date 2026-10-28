import { Injectable, Logger } from '@nestjs/common';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import {
  normalizeDoi,
  normalizeArxivId,
} from '@/modules/library/core/domain/identifier.domain';
import { normalizeAcademicTitle } from '@/modules/library/core/domain/academic-title.domain';

export interface ExtractedReferenceCandidate {
  title?: string;
  doi?: string;
  arxivId?: string;
  authors?: string[];
  year?: number | string;
  rawText?: string;
}

export interface ReferenceMatchResult {
  sourceItemId: string;
  targetItemId: string;
  matchType: 'DOI' | 'ARXIV' | 'TITLE_AUTHOR_YEAR' | 'TITLE';
  matchedTitle?: string;
  matchedDoi?: string;
}

interface ScopePaperRecord {
  id: string;
  title?: string | null;
  doi?: string | null;
  year?: number | null;
  metadata?: unknown;
  contributors?: Array<{
    lastName?: string | null;
    fullName?: string | null;
  }>;
}

@Injectable()
export class ReferenceMatcherService {
  private readonly logger = new Logger(ReferenceMatcherService.name);

  constructor(private readonly extractionRepo: ExtractionRepository) {}

  public static normalizeTitleKey(title: string): string {
    return normalizeAcademicTitle(title).replace(/\s+/g, '');
  }

  public static extractQuotedOrCleanedTitle(
    ref: ExtractedReferenceCandidate,
  ): string | undefined {
    if (ref.title && ref.title.trim().length > 5) {
      return ref.title.trim();
    }
    if (!ref.rawText) return undefined;

    // Match title in quotes: [1] A. Vaswani et al., "Attention is all you need," 2017.
    const quotedMatch = ref.rawText.match(
      /[""\u201C]([^""\u201D]{8,250})[""\u201D]/,
    );
    if (quotedMatch?.[1]) {
      return quotedMatch[1].replace(/[.,;]+$/, '').trim();
    }
    return undefined;
  }

  /**
   * Matches extracted bibliography references against items in the user's or project's library
   * using a single batch query (preventing N+1 database lookups) and O(1) hash maps.
   */
  async matchReferences(
    scope: { userId?: string; projectId?: string | null } | string,
    sourceItemId: string,
    references: ExtractedReferenceCandidate[],
  ): Promise<ReferenceMatchResult[]> {
    if (!references || references.length === 0) {
      return [];
    }

    const scopePapers = (await this.extractionRepo.findScopePapers(
      scope,
      sourceItemId,
    )) as ScopePaperRecord[];

    if (!scopePapers || scopePapers.length === 0) {
      return [];
    }

    const doiMap = new Map<string, ScopePaperRecord>();
    const arxivMap = new Map<string, ScopePaperRecord>();
    const titleMap = new Map<string, ScopePaperRecord>();

    for (const paper of scopePapers) {
      if (!paper.id || paper.id === sourceItemId) continue;

      const metaObj =
        paper.metadata &&
        typeof paper.metadata === 'object' &&
        !Array.isArray(paper.metadata)
          ? (paper.metadata as Record<string, unknown>)
          : {};

      const rawDoi =
        paper.doi ||
        (typeof metaObj.doi === 'string' ? metaObj.doi : undefined);
      const normDoi = normalizeDoi(rawDoi);
      if (normDoi) {
        doiMap.set(normDoi, paper);
      }

      const rawArxiv =
        typeof metaObj.arxivId === 'string' ? metaObj.arxivId : undefined;
      const normArxiv = normalizeArxivId(rawArxiv);
      if (normArxiv) {
        arxivMap.set(normArxiv, paper);
      }

      if (paper.title && paper.title.trim().length > 8) {
        const normTitle = ReferenceMatcherService.normalizeTitleKey(
          paper.title,
        );
        if (normTitle.length > 6) {
          titleMap.set(normTitle, paper);
        }
      }
    }

    const resultsByTarget = new Map<string, ReferenceMatchResult>();

    for (const ref of references) {
      let matchedPaper: ScopePaperRecord | undefined;
      let matchType: ReferenceMatchResult['matchType'] = 'TITLE';

      // 1. Exact normalized DOI match (handles https://doi.org/..., doi:..., trailing periods)
      const candidateDoi = normalizeDoi(ref.doi || ref.rawText);
      if (candidateDoi && doiMap.has(candidateDoi)) {
        matchedPaper = doiMap.get(candidateDoi);
        matchType = 'DOI';
      }

      // 2. Exact normalized arXiv ID match
      if (!matchedPaper) {
        const candidateArxiv = normalizeArxivId(ref.arxivId || ref.rawText);
        if (candidateArxiv && arxivMap.has(candidateArxiv)) {
          matchedPaper = arxivMap.get(candidateArxiv);
          matchType = 'ARXIV';
        }
      }

      // 3. Normalized Title (+ optional Author / Year confirmation)
      if (!matchedPaper) {
        const candidateTitle =
          ReferenceMatcherService.extractQuotedOrCleanedTitle(ref);
        if (candidateTitle && candidateTitle.length > 8) {
          const normTitle =
            ReferenceMatcherService.normalizeTitleKey(candidateTitle);
          const titleHit = titleMap.get(normTitle);
          if (titleHit) {
            const refYear = ref.year
              ? Number(ref.year)
              : ref.rawText?.match(/\b(19\d{2}|20\d{2})\b/)?.[1]
                ? Number(ref.rawText.match(/\b(19\d{2}|20\d{2})\b/)![1])
                : undefined;

            const yearConsistent =
              !refYear ||
              !titleHit.year ||
              Math.abs(titleHit.year - refYear) <= 1;

            if (yearConsistent) {
              matchedPaper = titleHit;
              matchType =
                refYear && titleHit.year ? 'TITLE_AUTHOR_YEAR' : 'TITLE';
            }
          }
        }
      }

      if (
        matchedPaper &&
        matchedPaper.id !== sourceItemId &&
        !resultsByTarget.has(matchedPaper.id)
      ) {
        resultsByTarget.set(matchedPaper.id, {
          sourceItemId,
          targetItemId: matchedPaper.id,
          matchType,
          matchedTitle:
            ref.title || matchedPaper.title || 'Cited in document bibliography',
          matchedDoi: candidateDoi || matchedPaper.doi || undefined,
        });
      }
    }

    return Array.from(resultsByTarget.values());
  }

  /**
   * Matches references and persists deduplicated 'cites' relations in the catalog graph.
   */
  async linkCitationsInLibrary(
    scope: { userId?: string; projectId?: string | null } | string,
    sourceItemId: string,
    references: ExtractedReferenceCandidate[],
  ): Promise<{ matchedCount: number; matches: ReferenceMatchResult[] }> {
    const matches = await this.matchReferences(scope, sourceItemId, references);
    if (matches.length === 0) {
      return { matchedCount: 0, matches: [] };
    }

    await Promise.all(
      matches.map(async (m) => {
        try {
          await this.extractionRepo.upsertItemCitationRelation(
            sourceItemId,
            m.targetItemId,
            m.matchedTitle || 'Cited in document bibliography',
          );
        } catch (err: unknown) {
          this.logger.debug(
            `Skipped duplicate or transient citation relation (${sourceItemId} -> ${m.targetItemId}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );

    return { matchedCount: matches.length, matches };
  }
}
