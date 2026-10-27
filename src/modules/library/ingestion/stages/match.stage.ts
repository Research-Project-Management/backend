import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { DuplicateMatchResult } from '@/modules/library/ingestion/types/metadata-candidate.types';
import { DuplicatePolicy } from '@/modules/library/ingestion/policies/duplicate.policy';
import {
  calculateTitleSimilarity,
  tokenizeTitleWords,
} from '@/modules/library/ingestion/domain/deduplication.domain';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  isPlaceholderItemTitle,
} from '@/modules/library/core';
import {
  IWorkflowStage,
  MatchStageInput,
} from '@/modules/library/ingestion/types/workflow-stage.types';

@Injectable()
export class MatchStage implements IWorkflowStage<
  MatchStageInput,
  DuplicateMatchResult
> {
  readonly stageName = 'MATCH' as const;
  private readonly logger = new Logger(MatchStage.name);

  constructor(
    private readonly duplicatePolicy: DuplicatePolicy,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
  ) {}

  /**
   * Evaluates potential duplicate matches against existing Items in the workspace.
   *
   * Strategy:
   *  1. Encapsulated Gateway Port: queries catalog via CATALOG_FACADE (findMatchCandidates)
   *     respecting bounded context boundaries.
   *  2. Fast-path: exact DOI/arXiv/PMID/ISBN lookup (O(1) with index). Exits immediately on hit.
   *  3. Fuzzy: Pre-filter by title keywords, then in-memory Jaccard similarity.
   */
  async execute(input: MatchStageInput): Promise<DuplicateMatchResult> {
    const { scope, proposedItem } = input;
    const actualProposed = proposedItem || {};

    const nestedMeta =
      'metadata' in actualProposed &&
      actualProposed.metadata &&
      typeof actualProposed.metadata === 'object'
        ? (actualProposed.metadata as Record<string, unknown>)
        : undefined;

    const normalizeStringField = (val: unknown): string | undefined => {
      if (typeof val === 'string') {
        const trimmed = val.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      }
      if (typeof val === 'number') {
        return String(val).trim();
      }
      return undefined;
    };

    const proposedDoi = actualProposed.doi?.toLowerCase().trim();
    const cleanArxiv =
      normalizeStringField(actualProposed.arxivId) ??
      normalizeStringField(nestedMeta?.arxivId);
    const cleanPmid =
      normalizeStringField(actualProposed.pmid) ??
      normalizeStringField(nestedMeta?.pmid);
    const rawIsbn =
      normalizeStringField(actualProposed.isbn) ??
      normalizeStringField(nestedMeta?.isbn);
    const cleanIsbn = rawIsbn ? rawIsbn.replace(/[-\s]/g, '') : undefined;
    const proposedTitle = actualProposed.title?.trim();
    const significantWords =
      proposedTitle && proposedTitle.length > 5
        ? tokenizeTitleWords(proposedTitle)
            .filter((w) => w.length >= 3)
            .slice(0, 3)
        : [];

    // Query Catalog exclusively via Hexagonal Gateway Port
    if (this.catalogGateway?.findMatchCandidates) {
      const normalizedScope =
        typeof scope === 'string' ? { userId: scope } : scope;
      const proposedYear =
        actualProposed.year !== undefined &&
        actualProposed.year !== null &&
        Number.isFinite(Number(actualProposed.year))
          ? Number(actualProposed.year)
          : undefined;
      const matchResult = await this.catalogGateway.findMatchCandidates(
        normalizedScope,
        {
          doi: proposedDoi,
          arxivId: cleanArxiv,
          pmid: cleanPmid,
          isbn: cleanIsbn,
          year: proposedYear,
          titleWords: significantWords,
          titlePrefix: proposedTitle,
        },
      );

      if (matchResult.exactMatch) {
        const existingTitle = matchResult.exactMatch.title?.trim();
        const isGenericTitle = (t?: string): boolean =>
          !t || t.length <= 5 || isPlaceholderItemTitle(t);

        const titlesConflict =
          Boolean(proposedTitle) &&
          Boolean(existingTitle) &&
          !isGenericTitle(proposedTitle) &&
          !isGenericTitle(existingTitle) &&
          calculateTitleSimilarity(proposedTitle ?? '', existingTitle ?? '') < 0.5;

        if (!titlesConflict) {
          return {
            matchType: 'EXACT',
            confidence: 1.0,
            targetItemId: matchResult.exactMatch.id,
            targetItemTitle: matchResult.exactMatch.title,
            matchReason: matchResult.exactMatch.matchReason,
            evidence: matchResult.exactMatch.evidence,
          };
        }
        this.logger.warn(
          `Ignored exact identifier match (${matchResult.exactMatch.matchReason}) due to conflicting titles: "${proposedTitle}" vs "${existingTitle}"`,
        );
      }

      if (matchResult.candidateItems && matchResult.candidateItems.length > 0) {
        return this.duplicatePolicy.evaluate(
          actualProposed,
          matchResult.candidateItems,
        );
      }

      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }

    this.logger.warn(
      'MatchStage invoked without catalogGateway; skipping duplicate matching',
    );
    return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
  }
}
