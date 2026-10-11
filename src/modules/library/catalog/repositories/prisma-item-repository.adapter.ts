import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { CommandRepository } from './command.repository';
import { QueryRepository } from './query.repository';
import { ItemAggregate } from '../core/domain/item.aggregate';
import {
  IItemRepositoryPort,
  FindManyItemsOptions,
  PaginatedItemsResult,
} from '../core/ports/item-repository.port';

@Injectable()
export class PrismaItemRepositoryAdapter implements IItemRepositoryPort {
  constructor(
    private readonly commandRepo: CommandRepository,
    private readonly queryRepo: QueryRepository,
    private readonly prisma: PrismaService,
  ) {}

  async save(
    aggregate: ItemAggregate,
    _options?: { idempotencyKey?: string; correlationId?: string },
  ): Promise<void> {
    const existing = await this.queryRepo.findById(
      aggregate.userId,
      aggregate.id,
      aggregate.projectId ?? undefined,
      undefined,
      false,
      true,
    );

    if (existing) {
      await this.commandRepo.update(
        aggregate.userId,
        aggregate.id,
        aggregate.version - 1,
        {
          title: aggregate.title,
          itemType: aggregate.itemType,
          doi: aggregate.doi ?? undefined,
          citationKey: aggregate.citationKey ?? undefined,
          abstract: aggregate.abstract ?? undefined,
          year: aggregate.year ?? undefined,
          publicationTitle: aggregate.publicationTitle ?? undefined,
          ...(aggregate.fields ?? {}),
        },
        undefined,
        aggregate.projectId ?? undefined,
      );
    } else {
      await this.commandRepo.create(
        aggregate.userId,
        {
          id: aggregate.id,
          uploadedById: aggregate.userId,
          title: aggregate.title,
          itemType: aggregate.itemType,
          doi: aggregate.doi ?? undefined,
          citationKey: aggregate.citationKey ?? undefined,
          abstract: aggregate.abstract ?? undefined,
          year: aggregate.year ?? undefined,
          publicationTitle: aggregate.publicationTitle ?? undefined,
          ...(aggregate.fields ?? {}),
        },
        undefined,
        aggregate.projectId ?? undefined,
      );
    }
  }

  async findById(
    userId: string,
    itemId: string,
    projectId?: string,
    includeDeleted: boolean = false,
  ): Promise<ItemAggregate | null> {
    const record = await this.queryRepo.findById(
      userId,
      itemId,
      projectId,
      undefined,
      false,
      includeDeleted,
    );

    if (!record) return null;

    return ItemAggregate.reconstitute({
      id: record.id,
      userId: record.userId,
      projectId: record.projectId,
      title: record.title,
      itemType: record.itemType,
      doi: record.doi,
      citationKey: record.citationKey,
      abstract: record.abstract,
      year: record.year,
      publicationTitle: record.publicationTitle,
      version: record.version ?? 1,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt,
      fields: record,
    });
  }

  async findMany(
    userId: string,
    options: FindManyItemsOptions,
  ): Promise<PaginatedItemsResult> {
    const rawItems = await this.queryRepo.findMany(
      userId,
      options as Parameters<QueryRepository['findMany']>[1],
    );
    const aggregates = (rawItems || []).map((record) =>
      ItemAggregate.reconstitute({
        id: record.id,
        userId: record.userId,
        projectId: record.projectId,
        title: record.title,
        itemType: record.itemType,
        doi: record.doi,
        citationKey: record.citationKey,
        abstract: record.abstract,
        year: record.year,
        publicationTitle: record.publicationTitle,
        version: record.version ?? 1,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        deletedAt: record.deletedAt,
        fields: record,
      }),
    );

    return {
      items: aggregates,
      totalCount: aggregates.length,
      nextCursor: undefined,
      hasNextPage: false,
    };
  }

  async delete(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    await this.commandRepo.softDelete(
      userId,
      itemId,
      undefined,
      undefined,
      projectId,
    );
  }

  async purge(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    return this.commandRepo.purge(userId, itemId, undefined, projectId);
  }

  async setMyPublication(
    userId: string,
    itemId: string,
    isMyPublication: boolean,
  ): Promise<ItemAggregate | null> {
    await this.commandRepo.update(userId, itemId, undefined, {
      isMyPublication,
    });
    return this.findById(userId, itemId);
  }

  async getRelations(itemId: string): Promise<unknown[]> {
    return this.queryRepo.getRelations(itemId);
  }

  async putRelation(sourceItemId: string, relation: unknown): Promise<void> {
    await this.commandRepo.putRelation(sourceItemId, relation);
  }

  async removeRelation(
    sourceItemId: string,
    targetItemId: string,
  ): Promise<void> {
    await this.commandRepo.removeRelation(sourceItemId, targetItemId);
  }
}
