import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { ItemMetadata } from '../types/metadata.types';
import { DuplicateMatchResult } from '../types/metadata-candidate.types';
import {
  DuplicatePolicy,
  ExistingItemSummary,
} from '../policies/duplicate.policy';
import { tokenizeTitleWords } from '../utils/deduplication.utils';
import { isUUID } from 'class-validator';
import {
  CATALOG_GATEWAY_PORT,
  ICatalogGatewayPort,
} from '../types/catalog-gateway.types';

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
    'stop',
  ]);

  constructor(
    private readonly duplicatePolicy: DuplicatePolicy,
    @Optional()
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway?: ICatalogGatewayPort,
    @Optional()
    private readonly prisma?: PrismaService,
  ) {}

  /**
   * Evaluates potential duplicate matches against existing Items in the workspace.
   *
   * Strategy:
   *  1. Encapsulated Gateway Port: queries catalog via CATALOG_GATEWAY_PORT (findMatchCandidates)
   *     respecting bounded context boundaries.
   *  2. Fast-path: exact DOI/arXiv/PMID/ISBN lookup (O(1) with index). Exits immediately on hit.
   *  3. Fuzzy: Pre-filter by title keywords, then in-memory Jaccard similarity.
   */
  async execute(
    scope: { userId?: string; projectId?: string | null } | string,
    proposed: ItemMetadata,
  ): Promise<DuplicateMatchResult> {
    const proposedDoi = proposed.doi?.toLowerCase().trim();
    const rawArxiv = proposed.arxivId || (proposed as any).metadata?.arxivId;
    const cleanArxiv = rawArxiv ? String(rawArxiv).trim() : undefined;
    const rawPmid = proposed.pmid || (proposed as any).metadata?.pmid;
    const cleanPmid = rawPmid ? String(rawPmid).trim() : undefined;
    const rawIsbn = proposed.isbn || (proposed as any).metadata?.isbn;
    const cleanIsbn = rawIsbn
      ? String(rawIsbn).replace(/[-\s]/g, '').trim()
      : undefined;
    const proposedTitle = proposed.title?.trim();
    const significantWords =
      proposedTitle && proposedTitle.length > 5
        ? tokenizeTitleWords(proposedTitle)
            .filter((w) => w.length >= 3)
            .slice(0, 3)
        : [];

    // ── Primary Path: Query Catalog via Hexagonal Gateway Port ──────────────
    if (this.catalogGateway?.findMatchCandidates) {
      const matchResult = await this.catalogGateway.findMatchCandidates(scope, {
        doi: proposedDoi,
        arxivId: cleanArxiv,
        pmid: cleanPmid,
        isbn: cleanIsbn,
        titleWords: significantWords,
        titlePrefix: proposedTitle,
      });

      if (matchResult.exactMatch) {
        return {
          matchType: 'EXACT',
          confidence: 1.0,
          targetItemId: matchResult.exactMatch.id,
          targetItemTitle: matchResult.exactMatch.title,
          matchReason: matchResult.exactMatch.matchReason as any,
          evidence: matchResult.exactMatch.evidence,
        };
      }

      if (matchResult.candidateItems && matchResult.candidateItems.length > 0) {
        return this.duplicatePolicy.evaluate(
          proposed,
          matchResult.candidateItems,
        );
      }

      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }

    // ── Fallback Path: Direct DB Query (Preserved for legacy test contexts) ─
    if (!this.prisma) {
      this.logger.warn(
        'MatchStage invoked without catalogGateway or prisma; skipping duplicate matching',
      );
      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }

    this.logger.warn(
      'MatchStage falling back to direct Prisma queries. Inject CATALOG_GATEWAY_PORT for DDD compliance.',
    );

    let scopeFilter: Record<string, any> | null = null;

    if (typeof scope === 'object' && scope !== null) {
      if (scope.projectId && isUUID(scope.projectId)) {
        scopeFilter = { projectId: scope.projectId };
      } else if (scope.userId && isUUID(scope.userId)) {
        scopeFilter = { userId: scope.userId };
      }
    } else if (typeof scope === 'string' && isUUID(scope)) {
      scopeFilter = {
        AND: [{ OR: [{ projectId: scope }, { userId: scope }] }],
      };
    }

    if (!scopeFilter) {
      this.logger.warn(
        'MatchStage invoked without a valid userId/projectId scope; skipping duplicate matching',
      );
      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }

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

    if (cleanArxiv) {
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

    if (cleanPmid) {
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

    if (cleanIsbn) {
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

    if (!proposedTitle || proposedTitle.length <= 5) {
      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }

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
      take: 200,
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
