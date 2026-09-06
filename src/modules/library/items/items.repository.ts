import { Injectable } from '@nestjs/common';
import { Prisma, RagStatus } from '@prisma/client';
import { ItemQueryRepository } from './repositories/item-query.repository';
import { ItemCommandRepository } from './repositories/item-command.repository';
import { parseAccessDate } from './constants/items.constants';
import {
  CreateCatalogItemData,
  UpdateCatalogItemData,
  CatalogItemSummary,
} from './types/items.types';

export { parseAccessDate } from './constants/items.constants';
export {
  CreateCatalogItemData,
  UpdateCatalogItemData,
} from './types/items.types';


/**
 * ItemsRepository acts as the unified Aggregate Root Repository Facade for the Library Domain.
 * Internally, it segregates responsibilities according to CQRS principles:
 * - Query and read operations are handled by ItemQueryRepository.
 * - Mutation and transactional command operations are handled by ItemCommandRepository.
 *
 * This design preserves 100% backward compatibility for existing consumers (ItemsService, ConversionService)
 * while keeping internal module boundaries clean and maintainable.
 */
@Injectable()
export class ItemsRepository {
  constructor(
    private readonly queryRepo: ItemQueryRepository,
    private readonly commandRepo: ItemCommandRepository,
  ) {}

  // ── Query Operations (Delegated to ItemQueryRepository) ──────────────────────

  async findById(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ) {
    return this.queryRepo.findById(workspaceId, id, tx);
  }

  async findByIds(
    workspaceId: string,
    ids: string[],
    tx?: Prisma.TransactionClient,
  ) {
    return this.queryRepo.findByIds(workspaceId, ids, tx);
  }

  async getItemSnapshot(
    workspaceId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ) {
    return this.queryRepo.getItemSnapshot(workspaceId, itemId, tx);
  }

  async getItemSnapshots(
    workspaceId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ) {
    return this.queryRepo.getItemSnapshots(workspaceId, itemIds, tx);
  }

  async findByDoi(
    workspaceId: string,
    doi: string,
    tx?: Prisma.TransactionClient,
  ) {
    return this.queryRepo.findByDoi(workspaceId, doi, tx);
  }

  async findMany(
    workspaceId: string,
    options: {
      view?: 'all' | 'recent' | 'unfiled' | 'trash';
      userId?: string;
      collectionId?: string;
      tagId?: string;
      search?: string;
      limit?: number;
      cursor?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<any[]> {
    return this.queryRepo.findMany(workspaceId, options, tx);
  }

  async count(
    workspaceId: string,
    options: {
      view?: 'all' | 'recent' | 'unfiled' | 'trash';
      userId?: string;
      collectionId?: string;
      tagId?: string;
      search?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    return this.queryRepo.count(workspaceId, options, tx);
  }

  async exists(
    workspaceId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    return this.queryRepo.exists(workspaceId, itemId, tx);
  }

  async assertExists(
    workspaceId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.queryRepo.assertExists(workspaceId, itemId, tx);
  }

  async existMany(
    workspaceId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, boolean>> {
    return this.queryRepo.existMany(workspaceId, itemIds, tx);
  }

  async findSummaryById(
    workspaceId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CatalogItemSummary | null> {
    return this.queryRepo.findSummaryById(workspaceId, itemId, tx);
  }

  async findSummariesByIds(
    workspaceId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<CatalogItemSummary[]> {
    return this.queryRepo.findSummariesByIds(workspaceId, itemIds, tx);
  }

  async getRelations(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<any[]> {
    return this.queryRepo.getRelations(itemId, tx);
  }

  async findQualityAuditItems(
    workspaceId: string,
    limit?: number,
    tx?: Prisma.TransactionClient,
  ) {
    return this.queryRepo.findQualityAuditItems(workspaceId, limit, tx);
  }

  async findDuplicateCandidateItems(
    workspaceId: string,
    limit?: number,
    tx?: Prisma.TransactionClient,
  ) {
    return this.queryRepo.findDuplicateCandidateItems(workspaceId, limit, tx);
  }

  // ── Command Operations (Delegated to ItemCommandRepository) ──────────────────

  async create(
    workspaceId: string,
    data: CreateCatalogItemData,
    tx?: Prisma.TransactionClient,
  ) {
    return this.commandRepo.create(workspaceId, data, tx);
  }

  async update(
    workspaceId: string,
    id: string,
    expectedVersion: number | undefined,
    data: UpdateCatalogItemData,
    tx?: Prisma.TransactionClient,
  ) {
    return this.commandRepo.update(workspaceId, id, expectedVersion, data, tx);
  }

  async softDelete(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    return this.commandRepo.softDelete(workspaceId, id, expectedVersion, tx);
  }

  async restore(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
  ) {
    return this.commandRepo.restore(workspaceId, id, expectedVersion, tx);
  }

  async purge(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    return this.commandRepo.purge(workspaceId, id, tx);
  }

  async putRelation(
    itemId: string,
    relation: any,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.commandRepo.putRelation(itemId, relation, tx);
  }

  async removeRelation(
    itemId: string,
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.commandRepo.removeRelation(itemId, targetItemId, tx);
  }

  async updateRagStatus(
    id: string,
    data: {
      ragStatus?: RagStatus;
      ragDocId?: string;
      ragIndexedAt?: Date;
      ragLastAttemptAt?: Date;
      ragError?: string | null;
    },
    tx?: Prisma.TransactionClient,
  ) {
    return this.commandRepo.updateRagStatus(id, data, tx);
  }

  // ── Domain Helpers ──────────────────────────────────────────────────────────

  toDomainSummary(item: any): CatalogItemSummary {
    const authors: string[] = Array.isArray(item.contributors)
      ? item.contributors
          .map(
            (c: any) =>
              c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          )
          .filter(Boolean)
      : [];

    const doiIdent = Array.isArray(item.identifiers)
      ? item.identifiers.find((i: any) => i.type === 'doi')?.value
      : null;

    return {
      id: item.id,
      workspaceId: item.workspaceId,
      title: item.title,
      itemType: item.itemType,
      year: item.year,
      doi: doiIdent || item.doi || null,
      primaryAuthors: authors,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}

export const CatalogRepository = ItemsRepository;
export type CatalogRepository = ItemsRepository;
