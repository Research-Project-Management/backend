import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { ConfigurationException } from '@/modules/library/core/errors/domain.exception';
import {
  normalizeExactMatchCandidateInput,
  buildExactMatchOrClauses,
  evaluateExactMatchSpecifications,
} from '@/modules/library/catalog/domain/match-specifications.domain';

export type PrismaClientOrTx = Prisma.TransactionClient | PrismaService;

export interface MatchCandidateResult {
  exactMatch?: {
    id: string;
    title: string;
    matchReason: 'DOI_EXACT' | 'ARXIV_EXACT' | 'PMID_EXACT' | 'ISBN_EXACT';
    evidence: Record<string, unknown>;
  } | null;
  candidateItems: Array<{
    id: string;
    title: string;
    doi: string | null;
    year: number | null;
    citationKey: string | null;
    authors: string[];
  }>;
}

@Injectable()
export class ItemMatchQueryRepository {
  constructor(
    @Optional()
    private readonly prisma?: PrismaService,
  ) {}

  private getClient(
    client?: PrismaClientOrTx,
  ): Prisma.TransactionClient | PrismaService {
    const c = client ?? this.prisma;
    if (!c) {
      throw new ConfigurationException(
        'No Prisma client or transaction provided',
      );
    }
    return c;
  }

  async findQualityAuditItems(
    client?: PrismaClientOrTx,
    userId?: string,
    limit: number = 2000,
    projectId?: string,
  ) {
    const activeClient = this.getClient(client);
    let scopeWhere: Prisma.ItemWhereInput = { deletedAt: null };
    if (projectId && isUuid(projectId)) {
      scopeWhere = { projectId, deletedAt: null };
    } else if (userId && isUuid(userId)) {
      scopeWhere = { userId, projectId: null, deletedAt: null };
    } else if (userId && !isUuid(userId)) {
      return [];
    }

    return activeClient.item.findMany({
      where: scopeWhere,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        doi: true,
        abstract: true,
        year: true,
        contributors: {
          select: { id: true, creatorType: true },
        },
        identifiers: {
          select: { type: true, value: true, canonicalUri: true },
        },
        metadata: true,
      },
    });
  }

  async findDuplicateCandidateItems(
    client?: PrismaClientOrTx,
    userId?: string,
    limit: number = 5000,
    projectId?: string,
  ) {
    const activeClient = this.getClient(client);
    let scopeWhere: Prisma.ItemWhereInput = { deletedAt: null };
    if (projectId && isUuid(projectId)) {
      scopeWhere = { projectId, deletedAt: null };
    } else if (userId && isUuid(userId)) {
      scopeWhere = { userId, projectId: null, deletedAt: null };
    } else if (userId && !isUuid(userId)) {
      return [];
    }

    const effectiveTake = limit && limit > 0 ? Math.min(limit, 5000) : 5000;

    return activeClient.item.findMany({
      where: scopeWhere,
      select: {
        id: true,
        title: true,
        itemType: true,
        doi: true,
        metadata: true,
        citationKey: true,
        year: true,
        identifiers: {
          select: { type: true, value: true, canonicalUri: true },
        },
        contributors: {
          select: {
            fullName: true,
            firstName: true,
            lastName: true,
            creatorType: true,
            orderIndex: true,
          },
          orderBy: { orderIndex: 'asc' },
        },
      },
      take: effectiveTake,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findProjectWithMembers(client?: PrismaClientOrTx, projectId?: string) {
    if (!projectId || !isUuid(projectId)) return null;
    const activeClient = this.getClient(client);
    return activeClient.project.findUnique({
      where: { id: projectId },
      include: { members: true },
    });
  }

  async findDuplicatesInProject(
    client: PrismaClientOrTx | undefined,
    projectId: string,
    criteriaList: Array<{
      doi?: string | null;
      citationKey?: string | null;
      title?: string | null;
    }>,
  ) {
    if (!isUuid(projectId) || !criteriaList?.length) return [];
    const activeClient = this.getClient(client);

    const dois = criteriaList
      .map((c) => c.doi?.trim())
      .filter((d): d is string => Boolean(d));
    const citationKeys = criteriaList
      .map((c) => c.citationKey?.trim())
      .filter((k): k is string => Boolean(k));
    const titles = criteriaList
      .map((c) => c.title?.trim())
      .filter((t): t is string => Boolean(t));

    const orConditions: Prisma.ItemWhereInput[] = [];
    if (dois.length > 0) orConditions.push({ doi: { in: dois } });
    if (citationKeys.length > 0)
      orConditions.push({ citationKey: { in: citationKeys } });
    if (titles.length > 0) orConditions.push({ title: { in: titles } });

    if (orConditions.length === 0) return [];

    return activeClient.item.findMany({
      where: {
        projectId,
        deletedAt: null,
        OR: orConditions,
      },
      select: {
        id: true,
        doi: true,
        citationKey: true,
        title: true,
      },
    });
  }

  async findByCitationKey(
    client: PrismaClientOrTx | undefined,
    userId: string,
    citationKey: string,
    projectId?: string,
  ) {
    if (!citationKey?.trim()) return null;
    const activeClient = this.getClient(client);
    const scopeWhere: Prisma.ItemWhereInput =
      projectId && isUuid(projectId)
        ? { projectId, deletedAt: null }
        : { userId, projectId: null, deletedAt: null };

    return activeClient.item.findFirst({
      where: {
        citationKey: { equals: citationKey.trim(), mode: 'insensitive' },
        ...scopeWhere,
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        itemTags: { include: { tag: true } },
        collectionItems: { include: { collection: true } },
        attachments: { include: { revisions: true } },
        notesList: { where: { deletedAt: null } },
        identifiers: {
          select: { type: true, value: true, canonicalUri: true },
        },
      },
    });
  }

  async findByCitationKeys(
    client: PrismaClientOrTx | undefined,
    userId: string,
    citationKeys: string[],
    projectId?: string,
  ) {
    const cleanKeys = (citationKeys || [])
      .map((k) => k?.trim())
      .filter((k): k is string => Boolean(k));
    if (cleanKeys.length === 0) return [];
    const activeClient = this.getClient(client);
    const scopeWhere: Prisma.ItemWhereInput =
      projectId && isUuid(projectId)
        ? { projectId, deletedAt: null }
        : { userId, projectId: null, deletedAt: null };

    return activeClient.item.findMany({
      where: {
        citationKey: { in: cleanKeys, mode: 'insensitive' },
        ...scopeWhere,
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        itemTags: { include: { tag: true } },
        collectionItems: { include: { collection: true } },
        attachments: { include: { revisions: true } },
        notesList: { where: { deletedAt: null } },
        identifiers: {
          select: { type: true, value: true, canonicalUri: true },
        },
      },
    });
  }

  async findMatchCandidates(
    client: PrismaClientOrTx | undefined,
    scope: { userId?: string; projectId?: string | null },
    criteria: {
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      year?: number | null;
      titleWords?: string[];
      titlePrefix?: string;
    },
  ): Promise<MatchCandidateResult> {
    let scopeWhere: Prisma.ItemWhereInput | null = null;
    if (scope.projectId && isUuid(scope.projectId)) {
      scopeWhere = { projectId: scope.projectId, deletedAt: null };
    } else if (scope.userId && isUuid(scope.userId)) {
      scopeWhere = { userId: scope.userId, projectId: null, deletedAt: null };
    }

    if (!scopeWhere) {
      return { exactMatch: null, candidateItems: [] };
    }

    const activeClient = this.getClient(client);

    // 1–4. Exact identifier match (DOI, arXiv ID, PMID, ISBN) via Specification Pattern
    const matchInput = normalizeExactMatchCandidateInput(criteria);
    const exactOrConditions = buildExactMatchOrClauses(matchInput);

    if (exactOrConditions.length > 0) {
      const match = (await activeClient.item.findFirst({
        where: {
          ...scopeWhere,
          OR: exactOrConditions,
        },
        select: {
          id: true,
          title: true,
          doi: true,
          metadata: true,
          identifiers: {
            select: { type: true, value: true, canonicalUri: true },
          },
        },
      })) as {
        id: string;
        title: string;
        doi?: string | null;
        metadata?: unknown;
        identifiers?: Array<{
          type?: string;
          value?: string;
          canonicalUri?: string | null;
        }>;
      } | null;
      if (match) {
        const evaluated = evaluateExactMatchSpecifications(matchInput, match);
        if (evaluated) {
          return {
            exactMatch: evaluated,
            candidateItems: [],
          };
        }
      }
    }

    // 5. Title candidate filter
    const words = (criteria.titleWords || [])
      .filter((w) => w.length >= 3)
      .slice(0, 3);
    let titleCondition: Prisma.ItemWhereInput | null = null;
    if (words.length > 0) {
      titleCondition = {
        OR: words.map((w) => ({ title: { contains: w, mode: 'insensitive' } })),
      };
    } else if (criteria.titlePrefix && criteria.titlePrefix.length > 3) {
      titleCondition = {
        title: {
          contains: criteria.titlePrefix.substring(0, 10),
          mode: 'insensitive',
        },
      };
    }

    if (!titleCondition) {
      return { exactMatch: null, candidateItems: [] };
    }

    const hasValidYear =
      criteria.year !== undefined &&
      criteria.year !== null &&
      Number.isFinite(Number(criteria.year));
    const targetYear = hasValidYear ? Number(criteria.year) : undefined;

    const items = await activeClient.item.findMany({
      where: {
        ...scopeWhere,
        ...(targetYear !== undefined
          ? {
              AND: [
                titleCondition,
                {
                  OR: [
                    { year: null },
                    {
                      year: {
                        gte: targetYear - 1,
                        lte: targetYear + 1,
                      },
                    },
                  ],
                },
              ],
            }
          : titleCondition),
      },
      select: {
        id: true,
        title: true,
        doi: true,
        year: true,
        citationKey: true,
        contributors: {
          select: { fullName: true },
          orderBy: { orderIndex: 'asc' },
        },
      },
      take: 200,
    });

    return {
      exactMatch: null,
      candidateItems: items.map((it) => ({
        id: it.id,
        title: it.title,
        doi: it.doi,
        year: it.year,
        citationKey: it.citationKey,
        authors: it.contributors.map((c) => c.fullName),
      })),
    };
  }

  private static readonly RECIPROCAL_RELATION_TYPE_MAP: Readonly<
    Record<string, string>
  > = {
    cites: 'cited_by',
    cited_by: 'cites',
    is_preprint_of: 'is_published_version_of',
    is_published_version_of: 'is_preprint_of',
    rebuts: 'rebutted_by',
    extends: 'extended_by',
    replicates: 'replicated_by',
    uses_dataset: 'dataset_used_by',
    survey_of: 'reviewed_in',
    supplements: 'supplemented_by',
    is_translation_of: 'translated_as',
  };

  async getRelations(
    client: PrismaClientOrTx | undefined,
    itemId: string,
  ): Promise<Record<string, unknown>[]> {
    if (!isUuid(itemId)) return [];
    const activeClient = this.getClient(client);
    const contributorInclude = {
      contributors: {
        where: { creatorType: 'author' },
        orderBy: { orderIndex: 'asc' as const },
      },
    };
    const relations = await activeClient.itemRelation.findMany({
      where: {
        OR: [
          { sourceItemId: itemId, targetItem: { deletedAt: null } },
          { targetItemId: itemId, sourceItem: { deletedAt: null } },
        ],
      },
      include: {
        sourceItem: { include: contributorInclude },
        targetItem: { include: contributorInclude },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!relations?.length) return [];

    const seenPeerIds = new Set<string>();
    const result: Record<string, unknown>[] = [];

    for (const r of relations) {
      const isOutgoing = r.sourceItemId === itemId;
      const peerItem = isOutgoing ? r.targetItem : r.sourceItem;
      if (!peerItem || peerItem.id === itemId || seenPeerIds.has(peerItem.id)) {
        continue;
      }
      seenPeerIds.add(peerItem.id);

      const rawType = r.relationType as string;
      const effectiveRelationType = isOutgoing
        ? rawType
        : (ItemMatchQueryRepository.RECIPROCAL_RELATION_TYPE_MAP[rawType] ??
          rawType);

      const authorNames = (peerItem.contributors || [])
        .map(
          (c: {
            fullName: string | null;
            firstName: string | null;
            lastName: string | null;
          }) =>
            c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        )
        .filter(Boolean);

      result.push({
        id: peerItem.id,
        relationId: r.id,
        targetItemId: peerItem.id,
        title: peerItem.title || 'Untitled Item',
        authors: authorNames,
        year: peerItem.year,
        doi: peerItem.doi,
        itemType: peerItem.itemType,
        citationKey: peerItem.citationKey,
        relationType: effectiveRelationType,
        direction: isOutgoing ? 'outgoing' : 'incoming',
        description: r.description || '',
        linkedAt: r.createdAt ? r.createdAt.toISOString() : undefined,
        targetItem: peerItem,
      });
    }

    return result;
  }
}
