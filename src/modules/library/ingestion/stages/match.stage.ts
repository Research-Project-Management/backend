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

  constructor(
    private readonly prisma: PrismaService,
    private readonly duplicatePolicy: DuplicatePolicy,
  ) {}

  /**
   * Evaluates potential duplicate matches against existing CatalogItems in the workspace.
   */
  async execute(
    workspaceId: string,
    proposed: ItemMetadata,
  ): Promise<DuplicateMatchResult> {
    const proposedDoi = proposed.doi?.toLowerCase().trim();

    // 1. Fast path: Direct DOI lookup in workspace
    if (proposedDoi) {
      const doiMatch = await this.prisma.catalogItem.findFirst({
        where: {
          workspaceId,
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

    // 2. Query recent items in workspace for fuzzy title matching
    const recentItems = await this.prisma.catalogItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        doi: true,
        year: true,
        citationKey: true,
        contributors: {
          select: { fullName: true },
        },
      },
      take: 200,
      orderBy: { createdAt: 'desc' },
    });

    const summaries: ExistingCatalogItemSummary[] = recentItems.map(
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
