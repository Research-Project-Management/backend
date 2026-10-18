import {
  Injectable,
  NotFoundException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import zlib from 'zlib';
import { PrismaService } from '@/core';
import { isUUID } from 'class-validator';
import { normalizeTags } from '@/modules/library/core/domain/tag.domain';
import {
  ItemSummary,
  ItemDetail,
} from '@/modules/library/catalog/types/items.types';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { TreeEngine } from '@/modules/library/catalog/domain/tree.engine';
import { ItemFilterOptions } from './item-filter-where.builder';
import {
  ItemMatchQueryRepository,
  MatchCandidateResult,
} from './item-match-query.repository';
import { ItemRelationsQueryRepository } from './item-relations-query.repository';
import { ItemListQueryRepository } from './item-list-query.repository';

export type { ItemFilterOptions } from './item-filter-where.builder';
export {
  buildItemWhereClause,
  buildItemSearchCondition,
} from './item-filter-where.builder';
export type { MatchCandidateResult } from './item-match-query.repository';
export { ItemMatchQueryRepository } from './item-match-query.repository';
export { ItemRelationsQueryRepository } from './item-relations-query.repository';
export { ItemListQueryRepository } from './item-list-query.repository';

const isUuid = (val: unknown): val is string =>
  typeof val === 'string' && isUUID(val);

@Injectable()
export class QueryRepository {
  private readonly treeEngine = new TreeEngine();
  private readonly matchRepo: ItemMatchQueryRepository;
  private readonly relationsRepo: ItemRelationsQueryRepository;
  private readonly listRepo: ItemListQueryRepository;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    matchRepo?: ItemMatchQueryRepository,
    @Optional()
    relationsRepo?: ItemRelationsQueryRepository,
    @Optional()
    listRepo?: ItemListQueryRepository,
  ) {
    this.matchRepo = matchRepo ?? new ItemMatchQueryRepository(this.prisma);
    this.relationsRepo =
      relationsRepo ?? new ItemRelationsQueryRepository(this.prisma);
    this.listRepo = listRepo ?? new ItemListQueryRepository(this.prisma);
  }

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findById(
    userId: string,
    id: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
    includeContent: boolean = true,
    includeDeleted: boolean = false,
  ): Promise<ItemDetail | null> {
    if (!isUuid(id) || !isUuid(userId)) return null;
    const client = this.getClient(tx);
    const item = await client.item.findFirst({
      where: {
        id,
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        ...(includeContent
          ? {
              notesList: {
                where: { deletedAt: null },
              },
              attachments: {
                include: { revisions: true },
              },
            }
          : {}),
      },
    });

    if (!item) {
      if (!includeDeleted) {
        const tombstone = await client.item.findUnique({
          where: { id },
          select: { metadata: true, deletedAt: true },
        });
        const tombstoneMeta =
          tombstone?.metadata &&
          typeof tombstone.metadata === 'object' &&
          !Array.isArray(tombstone.metadata)
            ? (tombstone.metadata as Record<string, unknown>)
            : undefined;
        const targetId =
          typeof tombstoneMeta?.mergedIntoId === 'string'
            ? tombstoneMeta.mergedIntoId
            : undefined;
        if (targetId && isUuid(targetId) && targetId !== id) {
          return this.findById(
            userId,
            targetId,
            projectId,
            tx,
            includeContent,
            false,
          );
        }
      }
      return null;
    }

    const isProjectScope = Boolean(projectId && isUuid(projectId));

    if (isProjectScope) {
      if (item.projectId !== projectId) return null;
      return item;
    }

    if (item.userId === userId && !item.projectId) {
      return item;
    }

    return null;
  }

  async findByIds(
    userId: string,
    ids: string[],
    projectId?: string,
    tx?: Prisma.TransactionClient,
    includeContent: boolean = true,
  ) {
    if (!isUuid(userId)) return [];
    const validIds = (ids || []).filter(isUuid);
    if (validIds.length === 0) return [];
    const client = this.getClient(tx);

    const scopeWhere: Prisma.ItemWhereInput =
      projectId && isUuid(projectId)
        ? { projectId }
        : { userId, projectId: null };

    return client.item.findMany({
      where: {
        id: { in: validIds },
        deletedAt: null,
        ...scopeWhere,
      },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        ...(includeContent
          ? {
              notesList: {
                where: { deletedAt: null },
              },
              attachments: true,
            }
          : {}),
      },
    });
  }

  async getItemSnapshot(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(itemId) || !isUuid(userId)) return null;
    const client = this.getClient(tx);
    const item = await client.item.findFirst({
      where: {
        id: itemId,
        projectId: null,
        deletedAt: null,
      },
      include: {
        itemTags: { include: { tag: true } },
      },
    });

    if (!item || item.userId !== userId) {
      return null;
    }

    const relationTags = item.itemTags.map((it) => it.tag.name);
    const tags = normalizeTags(relationTags);
    const meta = (item.metadata as Record<string, unknown>) ?? {};

    return {
      id: item.id,
      userId: item.userId,
      title: item.title,
      abstract: item.abstract,
      year: item.year,
      doi: item.doi,
      citationKey: item.citationKey,
      publicationTitle: meta.publicationTitle ?? null,
      volume: meta.volume ?? null,
      issue: meta.issue ?? null,
      pages: meta.pages ?? null,
      issn: meta.issn ?? null,
      isbn: meta.isbn ?? null,
      url: item.url,
      tags,
    };
  }

  async getItemSnapshots(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(userId)) return [];
    const validIds = (itemIds || []).filter(isUuid);
    if (validIds.length === 0) return [];

    const client = this.getClient(tx);
    return client.item.findMany({
      where: {
        userId,
        projectId: null,
        id: { in: validIds },
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        itemType: true,
        version: true,
        updatedAt: true,
      },
    });
  }

  async findByDoi(
    userId: string,
    doi: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(userId)) return null;
    const client = this.getClient(tx);
    const scopeWhere: Prisma.ItemWhereInput =
      projectId && projectId !== 'user' && isUuid(projectId)
        ? { projectId }
        : { userId, projectId: null };
    return client.item.findFirst({
      where: {
        ...scopeWhere,
        doi,
        deletedAt: null,
      },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        attachments: true,
      },
    });
  }

  /**
   * Retrieves the latest itemMetadata for an item and provider (e.g. mextract, pdf_fulltext).
   */
  async findItemMetadata(
    itemId: string,
    sourceProvider: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(itemId)) return null;
    const client = this.getClient(tx);
    const record = await client.itemMetadata.findFirst({
      where: {
        itemId,
        sourceProvider,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) return null;

    // Claim Check Pattern: Transparently hydrate offloaded payload from Object Storage
    const raw = record.rawPayload as
      | (Record<string, unknown> & { isOffloaded?: boolean; fileId?: string })
      | null;
    if (raw?.isOffloaded && raw?.fileId && this.storagePort?.readOwnedFile) {
      try {
        const storageFile = await this.storagePort.readOwnedFile({
          fileId: raw.fileId,
        });
        if (storageFile?.buffer) {
          const decompressed = zlib.gunzipSync(storageFile.buffer);
          const fullData = JSON.parse(decompressed.toString('utf-8')) as Record<
            string,
            unknown
          >;
          return {
            ...record,
            rawPayload: {
              ...raw,
              ...fullData,
            },
          };
        }
      } catch {
        // Fallback gracefully to summary record if storage cannot be reached
      }
    }

    return record;
  }

  async findMetadataSourceRecord(
    itemId: string,
    sourceProvider: string,
    tx?: Prisma.TransactionClient,
  ) {
    return this.findItemMetadata(itemId, sourceProvider, tx);
  }

  /**
   * Retrieves all itemMetadata records associated with an item across all providers.
   */
  async findMetadataSources(itemId: string, tx?: Prisma.TransactionClient) {
    if (!isUuid(itemId)) return [];
    const client = this.getClient(tx);
    return client.itemMetadata.findMany({
      where: { itemId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Resolves target collection IDs taking into account subcollection inheritance.
   * If options.collectionIds is explicitly provided, it is returned.
   * If options.collectionId is provided:
   *   - If includeSubcollections !== false and recursive !== false:
   *       queries all collections in scope to find descendants and returns [collectionId, ...descendantIds].
   *   - Otherwise, returns [collectionId].
   */
  async resolveTargetCollectionIds(
    userId: string,
    options: {
      collectionId?: string;
      collectionIds?: string[];
      includeSubcollections?: boolean;
      recursive?: boolean;
      projectId?: string;
    },
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<string[] | undefined> {
    return this.listRepo.resolveTargetCollectionIds(userId, options, client);
  }

  async findMany(
    userId: string,
    options: Parameters<ItemListQueryRepository['findMany']>[2],
    tx?: Prisma.TransactionClient,
  ): Promise<ItemDetail[]> {
    return this.listRepo.findMany(this.getClient(tx), userId, options);
  }

  buildWhereClause(
    userId: string,
    options: ItemFilterOptions,
  ): Prisma.ItemWhereInput {
    return this.listRepo.buildWhereClause(userId, options);
  }

  async count(
    userId: string,
    options: ItemFilterOptions & {
      includeSubcollections?: boolean;
      recursive?: boolean;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    return this.listRepo.count(this.getClient(tx), userId, options);
  }

  async countByItemType(
    userId: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Record<string, number>> {
    return this.listRepo.countByItemType(this.getClient(tx), userId, projectId);
  }

  async getProjectMemberRole(
    userId: string,
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string | null> {
    if (!isUuid(userId) || !isUuid(projectId)) return null;
    const client = this.getClient(tx);
    try {
      if (typeof client?.projectMember?.findFirst === 'function') {
        const member = await client.projectMember.findFirst({
          where: {
            projectId,
            userId,
            project: { deletedAt: null },
          },
          select: { role: true },
        });
        if (member?.role) return String(member.role).toLowerCase();
      }
      if (typeof client?.project?.findFirst === 'function') {
        const project = await client.project.findFirst({
          where: { id: projectId, deletedAt: null },
          select: { createdById: true },
        });
        if (project?.createdById === userId) return 'owner';
      }
    } catch {
      return null;
    }
    return null;
  }

  async exists(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<boolean> {
    if (!isUuid(itemId)) return false;
    const client = this.getClient(tx);

    const item = await client.item.findUnique({
      where: { id: itemId },
      select: { id: true, userId: true, projectId: true, deletedAt: true },
    });

    if (!item || item.deletedAt !== null) return false;

    if (!isUuid(userId) || userId === 'system') return true;

    if (projectId && projectId !== 'user' && isUuid(projectId)) {
      return item.projectId === projectId;
    }

    return item.userId === userId && !item.projectId;
  }

  async assertExists(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<void> {
    const isPresent = await this.exists(userId, itemId, tx, projectId);
    if (!isPresent) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }
  }

  async existMany(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (!itemIds || itemIds.length === 0) return result;
    const scopeWhere =
      projectId && projectId !== 'user' && isUuid(projectId)
        ? { projectId }
        : isUuid(userId)
          ? { userId, projectId: null }
          : null;
    if (!scopeWhere) {
      for (const id of itemIds) result.set(id, false);
      return result;
    }

    const validIds = itemIds.filter(isUuid);
    const client = this.getClient(tx);
    const found = await client.item.findMany({
      where: { id: { in: validIds }, ...scopeWhere, deletedAt: null },
      select: { id: true },
    });
    const foundSet = new Set(found.map((it) => it.id));
    for (const id of itemIds) {
      result.set(id, foundSet.has(id));
    }
    return result;
  }

  async findSummaryById(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<ItemSummary | null> {
    return this.listRepo.findSummaryById(
      this.getClient(tx),
      userId,
      itemId,
      projectId,
    );
  }

  async findSummariesByIds(
    userId: string,
    itemIds: string[],
    projectIdOrTx?: string | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ): Promise<ItemSummary[]> {
    const projectId =
      typeof projectIdOrTx === 'string' && isUuid(projectIdOrTx)
        ? projectIdOrTx
        : undefined;
    const client = this.getClient(
      typeof projectIdOrTx === 'object' ? projectIdOrTx : tx,
    );
    return this.listRepo.findSummariesByIds(client, userId, itemIds, projectId);
  }

  async getRelations(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Record<string, unknown>[]> {
    return this.relationsRepo.getRelations(this.getClient(tx), itemId);
  }

  async findQualityAuditItems(
    userId?: string,
    limit: number = 2000,
    projectIdOrTx?: string | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    const projectId =
      typeof projectIdOrTx === 'string' && isUuid(projectIdOrTx)
        ? projectIdOrTx
        : undefined;
    const client = this.getClient(
      typeof projectIdOrTx === 'object' ? projectIdOrTx : tx,
    );
    return this.matchRepo.findQualityAuditItems(
      client,
      userId,
      limit,
      projectId,
    );
  }

  async findDuplicateCandidateItems(
    userId?: string,
    limit: number = 5000,
    projectIdOrTx?: string | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    const projectId =
      typeof projectIdOrTx === 'string' && isUuid(projectIdOrTx)
        ? projectIdOrTx
        : undefined;
    const client = this.getClient(
      typeof projectIdOrTx === 'object' ? projectIdOrTx : tx,
    );
    return this.matchRepo.findDuplicateCandidateItems(
      client,
      userId,
      limit,
      projectId,
    );
  }

  async getFulltext(
    userId: string,
    itemId: string,
    projectIdOrTx?: string | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(itemId) || !isUuid(userId)) return null;
    const projectId =
      typeof projectIdOrTx === 'string' && isUuid(projectIdOrTx)
        ? projectIdOrTx
        : undefined;
    const client = this.getClient(
      typeof projectIdOrTx === 'object' ? projectIdOrTx : tx,
    );
    const scopeWhere: Prisma.ItemWhereInput = projectId
      ? { projectId }
      : { userId, projectId: null };
    const item = await client.item.findFirst({
      where: { id: itemId, ...scopeWhere, deletedAt: null },
      select: { id: true },
    });
    if (!item) return null;

    const sourceRecord = await client.itemMetadata.findFirst({
      where: {
        itemId: itemId,
        sourceProvider: {
          in: ['pdf_fulltext', 'mextract_fulltext', 'trusted_extraction'],
        },
      },
      orderBy: { fetchedAt: 'desc' },
    });

    return sourceRecord?.rawPayload || null;
  }

  async findProjectWithMembers(
    projectId: string,
    tx?: Prisma.TransactionClient,
  ) {
    return this.matchRepo.findProjectWithMembers(this.getClient(tx), projectId);
  }

  async findDuplicateInProject(
    projectId: string,
    criteria: {
      doi?: string | null;
      citationKey?: string | null;
      title: string;
    },
    tx?: Prisma.TransactionClient,
  ) {
    return this.matchRepo.findDuplicateInProject(
      this.getClient(tx),
      projectId,
      criteria,
    );
  }

  async findDuplicatesInProject(
    projectId: string,
    criteriaList: Array<{
      doi?: string | null;
      citationKey?: string | null;
      title?: string | null;
    }>,
    tx?: Prisma.TransactionClient,
  ) {
    return this.matchRepo.findDuplicatesInProject(
      this.getClient(tx),
      projectId,
      criteriaList,
    );
  }

  async findByCitationKey(
    userId: string,
    citationKey: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    return this.matchRepo.findByCitationKey(
      this.getClient(tx),
      userId,
      citationKey,
      projectId,
    );
  }

  async findByCitationKeys(
    userId: string,
    citationKeys: string[],
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    return this.matchRepo.findByCitationKeys(
      this.getClient(tx),
      userId,
      citationKeys,
      projectId,
    );
  }

  async findMatchCandidates(
    scope: { userId?: string; projectId?: string | null } | string,
    criteria: {
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      titleWords?: string[];
      titlePrefix?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<MatchCandidateResult> {
    return this.matchRepo.findMatchCandidates(
      this.getClient(tx),
      scope,
      criteria,
    );
  }
}
