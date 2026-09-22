import { Injectable, Logger } from '@nestjs/common';
import { IItemRepositoryPort } from '../../domain/ports/item-repository.port';
import { ItemAggregate } from '../../domain/model/item.aggregate';
import { QueryRepository } from '../repositories/query.repository';
import { CommandRepository } from '../repositories/command.repository';
import { TransactionService } from '../../../shared-kernel/outbox/transaction.service';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { ItemsMapper } from '../mappers/items.mapper';
import { syncTagsForCatalogItem } from '../mappers/command-payload.builder';

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
      true,
    );
    if (!raw) return null;

    const flattened = ItemsMapper.mapFlattenedState(raw, userId) as any;
    if (!flattened) return null;

    return ItemAggregate.reconstitute({
      id: flattened.id,
      userId: flattened.userId,
      projectId: flattened.projectId,
      title: flattened.title,
      itemType: flattened.itemType ?? flattened.type ?? 'journalArticle',
      doi: flattened.doi,
      citationKey: flattened.citationKey,
      abstract: flattened.abstract,
      year: flattened.year,
      publicationTitle:
        flattened.publicationTitle ??
        flattened.metadata?.publicationTitle ??
        null,
      version: flattened.version ?? 1,
      createdAt: flattened.createdAt,
      updatedAt: flattened.updatedAt,
      deletedAt: flattened.deletedAt,
      fields: flattened,
    });
  }

  async save(aggregate: ItemAggregate): Promise<void> {
    const domainEvents = aggregate.pullDomainEvents();

    await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const existing = await tx.item.findUnique({
        where: { id: aggregate.id },
        select: { id: true, version: true, metadata: true },
      });

      const {
        authors: _authors,
        creators: _creators,
        contributors: rawContributors,
        tags: _tags,
        labels: _labels,
        keywords: _keywords,
        collectionIds: rawCollectionIds,
        collections: _collections,
        collectionId: _collectionId,
        notes: rawNotes,
        notesList: _notesList,
        attachments: _attachments,
        primaryFile: _primaryFile,
        userStates: _userStates,
        states: _states,
        readStatus: _readStatus,
        rating: _rating,
        lastReadAt: _lastReadAt,
        identifiers: _identifiers,
        ...restFields
      } = (aggregate.fields ?? {}) as any;

      const existingMeta =
        existing?.metadata &&
        typeof existing.metadata === 'object' &&
        !Array.isArray(existing.metadata)
          ? (existing.metadata as Record<string, any>)
          : {};

      const metadataPayload = {
        ...existingMeta,
        ...restFields,
        ...(aggregate.publicationTitle
          ? { publicationTitle: aggregate.publicationTitle }
          : {}),
      };

      const rawTags = _tags || _keywords || _labels;
      const contribList =
        rawContributors ||
        _creators ||
        (Array.isArray(_authors)
          ? _authors.map((name: string, idx: number) => ({
              fullName: name,
              orderIndex: idx,
              creatorType: 'author',
            }))
          : null);

      if (!existing) {
        // Insert new item
        const contributorsCreate =
          Array.isArray(contribList) && contribList.length > 0
            ? {
                create: contribList.map((c: any, idx: number) => ({
                  creatorType: c.creatorType || 'author',
                  firstName: c.firstName || '',
                  lastName: c.lastName || '',
                  fullName:
                    c.fullName ||
                    c.name ||
                    [c.firstName, c.lastName].filter(Boolean).join(' ') ||
                    '',
                  orderIndex: c.orderIndex ?? idx,
                })),
              }
            : undefined;

        const collectionIds = [
          ...(Array.isArray(rawCollectionIds) ? rawCollectionIds : []),
          ...(_collectionId ? [_collectionId] : []),
        ].filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0,
        );
        const uniqueCollectionIds = Array.from(new Set(collectionIds));

        const collectionItemsCreate =
          uniqueCollectionIds.length > 0
            ? {
                create: uniqueCollectionIds.map((cid, idx) => ({
                  collectionId: cid,
                  sortOrder: idx,
                })),
              }
            : undefined;

        const notesCreate =
          Array.isArray(rawNotes) && rawNotes.length > 0
            ? {
                create: rawNotes.map((n: any) => ({
                  userId: aggregate.userId,
                  content: n.content || n.contentMd || n.note || '',
                  contentMd: n.contentMd || n.content || n.note || '',
                  note: n.note || `<p>${n.content || n.contentMd || ''}</p>`,
                })),
              }
            : undefined;

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
            metadata: metadataPayload,
            version: aggregate.version,
            deletedAt: aggregate.deletedAt,
            createdAt: aggregate.createdAt,
            updatedAt: aggregate.updatedAt,
            ...(contributorsCreate
              ? { contributors: contributorsCreate }
              : {}),
            ...(collectionItemsCreate
              ? { collectionItems: collectionItemsCreate }
              : {}),
            ...(notesCreate ? { notesList: notesCreate } : {}),
          },
        });

        if (Array.isArray(rawTags) && rawTags.length > 0) {
          await syncTagsForCatalogItem(
            tx,
            aggregate.userId,
            aggregate.id,
            rawTags,
          );
        }
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
            metadata: metadataPayload,
            version: aggregate.version,
            deletedAt: aggregate.deletedAt,
            updatedAt: aggregate.updatedAt,
          },
        });

        if (Array.isArray(rawTags)) {
          await syncTagsForCatalogItem(
            tx,
            aggregate.userId,
            aggregate.id,
            rawTags,
          );
        }

        if (Array.isArray(rawCollectionIds)) {
          const uniqueIds = Array.from(
            new Set(
              rawCollectionIds.filter(
                (id): id is string =>
                  typeof id === 'string' && id.trim().length > 0,
              ),
            ),
          );
          await tx.collectionItem.deleteMany({
            where: { itemId: aggregate.id },
          });
          if (uniqueIds.length > 0) {
            await tx.collectionItem.createMany({
              data: uniqueIds.map((cid, idx) => ({
                itemId: aggregate.id,
                collectionId: cid,
                sortOrder: idx,
              })),
            });
          }
        }

        if (Array.isArray(contribList)) {
          await tx.contributor.deleteMany({
            where: { itemId: aggregate.id },
          });
          if (contribList.length > 0) {
            await tx.contributor.createMany({
              data: contribList.map((c: any, idx: number) => ({
                itemId: aggregate.id,
                creatorType: c.creatorType || 'author',
                firstName: c.firstName || '',
                lastName: c.lastName || '',
                fullName:
                  c.fullName ||
                  c.name ||
                  [c.firstName, c.lastName].filter(Boolean).join(' ') ||
                  '',
                orderIndex: c.orderIndex ?? idx,
              })),
            });
          }
        }
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
      const flattened = ItemsMapper.mapFlattenedState(raw, userId) as any;
      return ItemAggregate.reconstitute({
        id: flattened.id,
        userId: flattened.userId,
        projectId: flattened.projectId,
        title: flattened.title,
        itemType: flattened.itemType ?? flattened.type ?? 'journalArticle',
        doi: flattened.doi,
        citationKey: flattened.citationKey,
        abstract: flattened.abstract,
        year: flattened.year,
        publicationTitle:
          flattened.publicationTitle ??
          flattened.metadata?.publicationTitle ??
          null,
        version: flattened.version ?? 1,
        createdAt: flattened.createdAt,
        updatedAt: flattened.updatedAt,
        deletedAt: flattened.deletedAt,
        fields: flattened,
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

  async purge(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    const eventScope = { userId, projectId: projectId || undefined };
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const purged = await this.commandRepo.purge(
        userId,
        itemId,
        tx,
        projectId,
      );
      await helpers.recordTombstone(eventScope, {
        entityType: 'Item',
        entityId: itemId,
      });
      await helpers.publishOutbox(eventScope, itemId, 'library.item.purged', {
        id: itemId,
        purgedAt: new Date(),
      });
      return purged;
    });
  }

  async setMyPublication(
    userId: string,
    itemId: string,
    isMyPublication: boolean,
  ): Promise<ItemAggregate | null> {
    await this.commandRepo.setMyPublication(userId, itemId, isMyPublication);
    return this.findById(userId, itemId);
  }

  async getRelations(itemId: string): Promise<any[]> {
    return this.queryRepo.getRelations(itemId);
  }

  async putRelation(
    sourceItemId: string,
    relation: {
      id: string;
      targetItemId: string;
      relationType: string;
      note?: string;
      linkedAt: string;
    },
  ): Promise<void> {
    await this.commandRepo.putRelation(sourceItemId, relation);
  }

  async removeRelation(
    sourceItemId: string,
    targetItemId: string,
  ): Promise<void> {
    await this.commandRepo.removeRelation(sourceItemId, targetItemId);
  }
}
