import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { ItemMetadata } from '../../domain/types/metadata.types';
import { DuplicateMatchResult } from '../../domain/types/metadata-candidate.types';
import {
  DuplicatePolicy,
  ExistingItemSummary,
} from '../../domain/policies/duplicate.policy';
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
    let scopeFilter: Record<string, any> = {};

    if (typeof scope === 'object' && scope !== null) {
      if (scope.projectId && isUUID(scope.projectId)) {
        scopeFilter = { projectId: scope.projectId };
      } else if (scope.userId && isUUID(scope.userId)) {
        scopeFilter = { userId: scope.userId };
      }
    } else if (typeof scope === 'string' && isUUID(scope)) {
      scopeFilter = { OR: [{ projectId: scope }, { userId: scope }] };
    }

    // ── Stage 1: Exact Identifier lookups (DOI, arXiv, PMID, ISBN) ───────────
    if (proposedDoi) {
      const doiMatch = await this.prisma.item.findFirst({
        where: {
          ...scopeFilter,
          doi: proposedDoi,
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

    // Extract first significant word to use as a DB pre-filter,
    // reducing the candidate set before running in-memory similarity.
    const firstSignificantWord =
      proposedTitle
        .toLowerCase()
        .split(/\s+/)
        .find((w) => w.length > 2 && !MatchStage.STOPWORDS.has(w)) ??
      proposedTitle.toLowerCase().split(/\s+/)[0];

    const candidateItems = await this.prisma.item.findMany({
      where: {
        ...scopeFilter,
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
