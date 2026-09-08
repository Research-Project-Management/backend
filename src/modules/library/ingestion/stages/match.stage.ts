import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { ItemMetadata } from '../metadata/types/metadata.types';
import { DuplicateMatchResult } from '../types/metadata-candidate.types';
import {
  DuplicatePolicy,
  ExistingCatalogItemSummary,
} from '../policies/duplicate.policy';

@Injectable()
export class MatchStage {
  private readonly logger = new Logger(MatchStage.name);

  private static readonly STOPWORDS = new Set([
    'the',
    'a',
    'an',
    'on',
    'in',
    'of',
    'and',
    'or',
    'to',
    'for',
    'with',
    'at',
    'by',
    'from',
    'is',
    'are',
    'was',
    'be',
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly duplicatePolicy: DuplicatePolicy,
  ) {}

  /**
   * Evaluates potential duplicate matches against existing CatalogItems in the workspace.
   *
   * Strategy:
   *  1. Fast-path: exact DOI lookup (O(1) with index). Exits immediately on hit.
   *  2. Fuzzy: DB pre-filter by first significant title word (insensitive contains),
   *     then in-memory Jaccard similarity on the reduced candidate set.
   *     This keeps fuzzy matching accurate without loading the entire workspace.
   */
  async execute(
    workspaceId: string,
    proposed: ItemMetadata,
  ): Promise<DuplicateMatchResult> {
    const proposedDoi = proposed.doi?.toLowerCase().trim();

    // ── Stage 1: Exact DOI lookup ─────────────────────────────────────────────
    if (proposedDoi) {
      const doiMatch = await this.prisma.catalogItem.findFirst({
        where: { workspaceId, doi: proposedDoi, deletedAt: null },
        select: { id: true, title: true, doi: true },
      });

      if (doiMatch) {
        return {
          matchType: 'EXACT',
          confidence: 1.0,
          targetItemId: doiMatch.id,
          targetItemTitle: doiMatch.title,
          matchReason: 'DOI_EXACT',
          evidence: { doi: proposedDoi },
        };
      }
    }

    // ── Stage 2: Fuzzy title matching ─────────────────────────────────────────
    const proposedTitle = proposed.title?.trim();
    if (!proposedTitle || proposedTitle.length <= 5) {
      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }

    // Extract first significant word to use as a DB pre-filter,
    // reducing the candidate set before running in-memory similarity.
    const firstSignificantWord =
      proposedTitle
        .toLowerCase()
        .split(/\s+/)
        .find((w) => w.length > 2 && !MatchStage.STOPWORDS.has(w)) ??
      proposedTitle.toLowerCase().split(/\s+/)[0];

    const candidateItems = await this.prisma.catalogItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        title: { contains: firstSignificantWord, mode: 'insensitive' },
      },
      select: {
        id: true,
        title: true,
        doi: true,
        year: true,
        citationKey: true,
        contributors: { select: { fullName: true } },
      },
      take: 500, // generous upper bound after DB pre-filter
    });

    if (candidateItems.length === 0) {
      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }

    const summaries: ExistingCatalogItemSummary[] = candidateItems.map(
      (it: any) => ({
        id: it.id,
        title: it.title,
        doi: it.doi,
        year: it.year,
        citationKey: it.citationKey,
        authors: it.contributors.map((c: any) => c.fullName),
      }),
    );

    return this.duplicatePolicy.evaluate(proposed, summaries);
  }
}
