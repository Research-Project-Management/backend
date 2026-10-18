import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import { ItemMetadata } from '@/modules/library/ingestion/types/metadata.types';
import { DuplicateMatchResult } from '@/modules/library/ingestion/types/metadata-candidate.types';
import {
  DuplicatePolicy,
  ExistingItemSummary,
} from '@/modules/library/ingestion/policies/duplicate.policy';
import { tokenizeTitleWords } from '@/modules/library/ingestion/domain/deduplication.domain';
import { isUUID } from 'class-validator';
import { CATALOG_FACADE, ICatalogFacade } from '@/modules/library/core';
import {
  IWorkflowStage,
  MatchStageInput,
} from '@/modules/library/ingestion/types/workflow-stage.types';

@Injectable()
export class MatchStage implements IWorkflowStage<
  MatchStageInput | { userId?: string; projectId?: string | null } | string,
  DuplicateMatchResult
> {
  readonly stageName = 'MATCH' as const;
  private readonly logger = new Logger(MatchStage.name);

  constructor(
    private readonly duplicatePolicy: DuplicatePolicy,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
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
    scopeOrInput:
      MatchStageInput | { userId?: string; projectId?: string | null } | string,
    proposed?: ItemMetadata,
  ): Promise<DuplicateMatchResult> {
    const isStageInput =
      typeof scopeOrInput === 'object' &&
      scopeOrInput !== null &&
      'scope' in scopeOrInput;
    const scope = isStageInput ? scopeOrInput.scope : scopeOrInput;
    const actualProposed = isStageInput
      ? scopeOrInput.proposedItem || {}
      : proposed || {};

    const nestedMeta =
      'metadata' in actualProposed &&
      actualProposed.metadata &&
      typeof actualProposed.metadata === 'object'
        ? (actualProposed.metadata as Record<string, unknown>)
        : undefined;

    const proposedDoi = actualProposed.doi?.toLowerCase().trim();
    const rawArxiv = actualProposed.arxivId || nestedMeta?.arxivId;
    const cleanArxiv = rawArxiv ? String(rawArxiv).trim() : undefined;
    const rawPmid = actualProposed.pmid || nestedMeta?.pmid;
    const cleanPmid = rawPmid ? String(rawPmid).trim() : undefined;
    const rawIsbn = actualProposed.isbn || nestedMeta?.isbn;
    const cleanIsbn = rawIsbn
      ? String(rawIsbn).replace(/[-\s]/g, '').trim()
      : undefined;
    const proposedTitle = actualProposed.title?.trim();
    const significantWords =
      proposedTitle && proposedTitle.length > 5
        ? tokenizeTitleWords(proposedTitle)
            .filter((w) => w.length >= 3)
            .slice(0, 3)
        : [];

    // Primary Path: Query Catalog via Hexagonal Gateway Port
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
          matchReason: matchResult.exactMatch.matchReason,
          evidence: matchResult.exactMatch.evidence,
        };
      }

      if (matchResult.candidateItems && matchResult.candidateItems.length > 0) {
        return this.duplicatePolicy.evaluate(
          actualProposed,
          matchResult.candidateItems,
        );
      }

      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }

    // Fallback Path: Direct DB Query (Fallback when Gateway Port is omitted)
    if (!this.prisma) {
      this.logger.warn(
        'MatchStage invoked without catalogGateway or prisma; skipping duplicate matching',
      );
      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }

    this.logger.warn(
      'MatchStage falling back to direct Prisma queries. Inject CATALOG_GATEWAY_PORT for DDD compliance.',
    );

    let scopeFilter: Prisma.ItemWhereInput | null = null;

    if (typeof scope === 'object' && scope !== null) {
      if (scope.projectId && isUUID(scope.projectId)) {
        scopeFilter = { projectId: scope.projectId };
      } else if (scope.userId && isUUID(scope.userId)) {
        scopeFilter = { userId: scope.userId, projectId: null };
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

    const summaries: ExistingItemSummary[] = candidateItems.map((it) => ({
      id: it.id,
      title: it.title,
      doi: it.doi,
      year: it.year,
      citationKey: it.citationKey,
      authors: it.contributors.map((c) => c.fullName),
    }));

    return this.duplicatePolicy.evaluate(actualProposed, summaries);
  }
}
