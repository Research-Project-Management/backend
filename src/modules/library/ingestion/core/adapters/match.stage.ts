import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { ItemMetadata } from '../domain/metadata.types';
import { DuplicateMatchResult } from '../domain/metadata-candidate.types';
import {
  DuplicatePolicy,
  ExistingItemSummary,
} from '../domain/duplicate.policy';
import { tokenizeTitleWords } from '../domain/deduplication.utils';
import { isUUID } from 'class-validator';

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
   * Evaluates potential duplicate matches against existing Items in the workspace.
   *
   * Strategy:
   *  1. Fast-path: exact DOI lookup (O(1) with index). Exits immediately on hit.
   *  2. Fuzzy: DB pre-filter by first significant title word (insensitive contains),
   *     then in-memory Jaccard similarity on the reduced candidate set.
   *     This keeps fuzzy matching accurate without loading the entire workspace.
   */
  async execute(
    scope: { userId?: string; projectId?: string | null } | string,
    proposed: ItemMetadata,
  ): Promise<DuplicateMatchResult> {
    const proposedDoi = proposed.doi?.toLowerCase().trim();
    let scopeFilter: Record<string, any> | null = null;

    if (typeof scope === 'object' && scope !== null) {
      if (scope.projectId && isUUID(scope.projectId)) {
        scopeFilter = { projectId: scope.projectId };
      } else if (scope.userId && isUUID(scope.userId)) {
        scopeFilter = { userId: scope.userId };
      }
    } else if (typeof scope === 'string' && isUUID(scope)) {
      // Wrapped in AND so that later `OR` keys in the where clauses (arXiv
      // variants, title pre-filter) cannot overwrite the tenant restriction
      // when spread together.
      scopeFilter = {
        AND: [{ OR: [{ projectId: scope }, { userId: scope }] }],
      };
    }

    // Fail closed: without a valid tenant scope, never match globally across
    // tenants (a cross-tenant match could lead ENRICH_EXISTING to patch a
    // foreign item). Treat as no match so the caller creates a new item.
    if (!scopeFilter) {
      this.logger.warn(
        'MatchStage invoked without a valid userId/projectId scope; skipping duplicate matching',
      );
      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }

    // ── Stage 1: Exact Identifier lookups (DOI, arXiv, PMID, ISBN) ───────────
    if (proposedDoi) {
      const doiMatch = await this.prisma.item.findFirst({
        where: {
          ...scopeFilter,
          doi: { equals: proposedDoi, mode: 'insensitive' },
          deletedAt: null,
        },
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

    const rawArxiv = proposed.arxivId || (proposed as any).metadata?.arxivId;
    if (rawArxiv) {
      const cleanArxiv = String(rawArxiv).trim();
      const baseArxiv = cleanArxiv.replace(/v\d+$/i, '');
      const arxivMatch = await this.prisma.item.findFirst({
        where: {
          ...scopeFilter,
          deletedAt: null,
          OR: [
            { metadata: { path: ['arxivId'], equals: cleanArxiv } },
            { metadata: { path: ['arxivId'], equals: baseArxiv } },
          ],
        },
        select: { id: true, title: true },
      });

      if (arxivMatch) {
        return {
          matchType: 'EXACT',
          confidence: 1.0,
          targetItemId: arxivMatch.id,
          targetItemTitle: arxivMatch.title,
          matchReason: 'ARXIV_EXACT',
          evidence: { arxivId: cleanArxiv },
        };
      }
    }

    const rawPmid = proposed.pmid || (proposed as any).metadata?.pmid;
    if (rawPmid) {
      const cleanPmid = String(rawPmid).trim();
      const pmidMatch = await this.prisma.item.findFirst({
        where: {
          ...scopeFilter,
          deletedAt: null,
          metadata: { path: ['pmid'], equals: cleanPmid },
        },
        select: { id: true, title: true },
      });

      if (pmidMatch) {
        return {
          matchType: 'EXACT',
          confidence: 1.0,
          targetItemId: pmidMatch.id,
          targetItemTitle: pmidMatch.title,
          matchReason: 'PMID_EXACT',
          evidence: { pmid: cleanPmid },
        };
      }
    }

    const rawIsbn = proposed.isbn || (proposed as any).metadata?.isbn;
    if (rawIsbn) {
      const cleanIsbn = String(rawIsbn).replace(/[-\s]/g, '').trim();
      const isbnMatch = await this.prisma.item.findFirst({
        where: {
          ...scopeFilter,
          deletedAt: null,
          metadata: { path: ['isbn'], equals: cleanIsbn },
        },
        select: { id: true, title: true },
      });

      if (isbnMatch) {
        return {
          matchType: 'EXACT',
          confidence: 1.0,
          targetItemId: isbnMatch.id,
          targetItemTitle: isbnMatch.title,
          matchReason: 'ISBN_EXACT',
          evidence: { isbn: cleanIsbn },
        };
      }
    }

    // ── Stage 2: Fuzzy title matching ─────────────────────────────────────────
    const proposedTitle = proposed.title?.trim();
    if (!proposedTitle || proposedTitle.length <= 5) {
      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }

    // Extract top significant words to use as a resilient DB pre-filter,
    // avoiding false negatives caused by leading words like "Towards", "A Study of", etc.
    const significantWords = tokenizeTitleWords(proposedTitle)
      .filter((w) => w.length >= 3)
      .slice(0, 3);

    const titleFilter =
      significantWords.length > 0
        ? {
            OR: significantWords.map((word) => ({
              title: { contains: word, mode: 'insensitive' as const },
            })),
          }
        : {
            title: {
              contains: proposedTitle.substring(0, 10),
              mode: 'insensitive' as const,
            },
          };

    const candidateItems = await this.prisma.item.findMany({
      where: {
        ...scopeFilter,
        deletedAt: null,
        ...titleFilter,
      },
      select: {
        id: true,
        title: true,
        doi: true,
        year: true,
        citationKey: true,
        contributors: { select: { fullName: true } },
      },
      take: 200, // resilient upper bound after multi-token filter
    });

    if (candidateItems.length === 0) {
      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }

    const summaries: ExistingItemSummary[] = candidateItems.map((it: any) => ({
      id: it.id,
      title: it.title,
      doi: it.doi,
      year: it.year,
      citationKey: it.citationKey,
      authors: it.contributors.map((c: any) => c.fullName),
    }));

    return this.duplicatePolicy.evaluate(proposed, summaries);
  }
}
