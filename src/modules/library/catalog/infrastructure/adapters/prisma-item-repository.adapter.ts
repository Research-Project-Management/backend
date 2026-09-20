import { Injectable, Logger } from '@nestjs/common';
import { IItemRepositoryPort } from '../../domain/ports/item-repository.port';
import { ItemAggregate } from '../../domain/model/item.aggregate';
import { QueryRepository } from '../repositories/query.repository';
import { CommandRepository } from '../repositories/command.repository';
import { TransactionService } from '../../../shared-kernel/outbox/transaction.service';
import { PrismaService } from '../../../../../core/database/prisma.service';

/**
 * Infrastructure Adapter implementing IItemRepositoryPort using Prisma & Outbox.
 * Adheres to Clean Architecture / Hexagonal Ports & Adapters.
 */
@Injectable()
export class PrismaItemRepositoryAdapter implements IItemRepositoryPort {
  private readonly logger = new Logger(PrismaItemRepositoryAdapter.name);

  constructor(
    private readonly queryRepo: QueryRepository,
    private readonly commandRepo: CommandRepository,
    private readonly prisma: PrismaService,
    private readonly libraryTx: TransactionService,
  ) {}

  async findById(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemAggregate | null> {
    const raw = await this.queryRepo.findById(
      userId,
      itemId,
      projectId,
      undefined,
      false,
    );
    if (!raw) return null;

    return ItemAggregate.reconstitute({
      id: raw.id,
      userId: raw.userId,
      projectId: raw.projectId,
      title: raw.title,
      itemType: raw.itemType ?? 'journalArticle',
      doi: raw.doi,
      citationKey: raw.citationKey,
      abstract: raw.abstract,
      year: raw.year,
      publicationTitle: raw.publicationTitle,
      version: raw.version ?? 1,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      deletedAt: raw.deletedAt,
      fields: (raw as any).fields ?? (raw as any).extra ?? {},
    });
  }

  async save(aggregate: ItemAggregate): Promise<void> {
    const domainEvents = aggregate.pullDomainEvents();

    await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const existing = await tx.item.findUnique({
        where: { id: aggregate.id },
        select: { id: true, version: true },
      });

      if (!existing) {
        // Insert new item
        await tx.item.create({
          data: {
            id: aggregate.id,
            userId: aggregate.userId,
            projectId: aggregate.projectId ?? null,
            title: aggregate.title,
            itemType: aggregate.itemType,
            doi: aggregate.doi,
            citationKey: aggregate.citationKey,
            abstract: aggregate.abstract,
            year: aggregate.year,
            publicationTitle: aggregate.publicationTitle,
            extra:
              Object.keys(aggregate.fields).length > 0
                ? JSON.stringify(aggregate.fields)
                : '',
            version: aggregate.version,
            deletedAt: aggregate.deletedAt,
            createdAt: aggregate.createdAt,
            updatedAt: aggregate.updatedAt,
          },
        });
      } else {
        // Update existing item with version increment
        await tx.item.update({
          where: { id: aggregate.id },
          data: {
            title: aggregate.title,
            itemType: aggregate.itemType,
            doi: aggregate.doi,
            citationKey: aggregate.citationKey,
            abstract: aggregate.abstract,
            year: aggregate.year,
            publicationTitle: aggregate.publicationTitle,
            extra:
              Object.keys(aggregate.fields).length > 0
                ? JSON.stringify(aggregate.fields)
                : '',
            version: aggregate.version,
            deletedAt: aggregate.deletedAt,
            updatedAt: aggregate.updatedAt,
          },
        });
      }

      // Record outbox events for all domain events emitted by the aggregate
      for (const event of domainEvents) {
        await helpers.publishOutbox(
          { userId: aggregate.userId, projectId: aggregate.projectId ?? null },
          aggregate.id,
          event.eventType,
          {
            eventId: event.eventId,
            occurredAt: event.occurredAt.toISOString(),
            aggregateId: aggregate.id,
            userId: aggregate.userId,
            projectId: aggregate.projectId,
            version: aggregate.version,
          },
        );
      }
    });
  }

  async findMany(
    userId: string,
    options: import('../../domain/ports/item-repository.port').FindManyItemsOptions,
  ): Promise<
    import('../../domain/ports/item-repository.port').PaginatedItemsResult
  > {
    const limit = Math.min(options.limit ?? 50, 100);
    const queryOptions: any = { ...options, userId };
    const [totalCount, rawItems] = await Promise.all([
      this.queryRepo.count(userId, queryOptions),
      this.queryRepo.findMany(userId, {
        ...queryOptions,
        limit: limit + 1,
      }),
    ]);

    let hasNextPage = false;
    let nextCursor: string | undefined;

    if (rawItems.length > limit) {
      hasNextPage = true;
      rawItems.pop();
      nextCursor = rawItems[rawItems.length - 1]?.id;
    }

    const items = rawItems.slice(0, limit).map((raw: any) => {
      let parsedExtra = {};
      if (raw.extra && typeof raw.extra === 'string') {
        try {
          parsedExtra = JSON.parse(raw.extra);
        } catch {
          parsedExtra = {};
        }
      }
      return ItemAggregate.reconstitute({
        id: raw.id,
        userId: raw.userId,
        projectId: raw.projectId,
        title: raw.title,
        itemType: raw.itemType ?? 'journalArticle',
        doi: raw.doi,
        citationKey: raw.citationKey,
        abstract: raw.abstract,
        year: raw.year,
        publicationTitle: raw.publicationTitle,
        version: raw.version ?? 1,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        deletedAt: raw.deletedAt,
        fields: raw.fields ?? parsedExtra,
      });
    });

    return {
      items,
      totalCount,
      nextCursor,
      hasNextPage,
    };
  }

  async delete(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    await this.prisma.item.deleteMany({
      where: {
        id: itemId,
        userId,
        ...(projectId ? { projectId } : {}),
      },
    });
  }
}
