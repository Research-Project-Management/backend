import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { PrismaService } from '@/core';
import { ConfigurationException } from '@/modules/library/core/errors/domain.exception';

const isUuid = (val: unknown): val is string =>
  typeof val === 'string' && isUUID(val);

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
          where: { creatorType: 'author' },
          select: { id: true },
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
        contributors: {
          where: { creatorType: 'author' },
          select: {
            fullName: true,
            firstName: true,
            lastName: true,
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

    // 1–4. Exact identifier match (DOI, arXiv ID, PMID, ISBN) in a single query
    const cleanDoi = criteria.doi?.trim()
      ? criteria.doi.trim().toLowerCase()
      : '';
    const cleanArxiv = criteria.arxivId?.trim() ? criteria.arxivId.trim() : '';
    const baseArxiv = cleanArxiv ? cleanArxiv.replace(/v\d+$/i, '') : '';
    const cleanPmid = criteria.pmid?.trim() ? criteria.pmid.trim() : '';
    const cleanIsbn = criteria.isbn?.trim()
      ? criteria.isbn.replace(/[-\s]/g, '').trim()
      : '';

    const exactOrConditions: Prisma.ItemWhereInput[] = [];
    if (cleanDoi) {
      exactOrConditions.push({
        doi: { equals: cleanDoi, mode: 'insensitive' },
      });
    }
    if (cleanArxiv) {
      exactOrConditions.push(
        { metadata: { path: ['arxivId'], equals: cleanArxiv } },
        { metadata: { path: ['arxivId'], equals: baseArxiv } },
      );
    }
    if (cleanPmid) {
      exactOrConditions.push({
        metadata: { path: ['pmid'], equals: cleanPmid },
      });
    }
    if (cleanIsbn) {
      exactOrConditions.push({
        metadata: { path: ['isbn'], equals: cleanIsbn },
      });
    }

    if (exactOrConditions.length > 0) {
      const match = await activeClient.item.findFirst({
        where: {
          ...scopeWhere,
          OR: exactOrConditions,
        },
        select: { id: true, title: true, doi: true, metadata: true },
      });
      if (match) {
        const meta =
          match.metadata &&
          typeof match.metadata === 'object' &&
          !Array.isArray(match.metadata)
            ? (match.metadata as Record<string, unknown>)
            : {};
        if (
          cleanDoi &&
          (!match.doi || match.doi.trim().toLowerCase() === cleanDoi)
        ) {
          return {
            exactMatch: {
              id: match.id,
              title: match.title,
              matchReason: 'DOI_EXACT',
              evidence: { doi: cleanDoi },
            },
            candidateItems: [],
          };
        }
        if (
          cleanArxiv &&
          (!meta.arxivId ||
            meta.arxivId === cleanArxiv ||
            meta.arxivId === baseArxiv)
        ) {
          return {
            exactMatch: {
              id: match.id,
              title: match.title,
              matchReason: 'ARXIV_EXACT',
              evidence: { arxivId: cleanArxiv },
            },
            candidateItems: [],
          };
        }
        if (cleanPmid && (!meta.pmid || meta.pmid === cleanPmid)) {
          return {
            exactMatch: {
              id: match.id,
              title: match.title,
              matchReason: 'PMID_EXACT',
              evidence: { pmid: cleanPmid },
            },
            candidateItems: [],
          };
        }
        if (cleanIsbn) {
          return {
            exactMatch: {
              id: match.id,
              title: match.title,
              matchReason: 'ISBN_EXACT',
              evidence: { isbn: cleanIsbn },
            },
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

    const items = await activeClient.item.findMany({
      where: {
        ...scopeWhere,
        ...titleCondition,
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
}
