import { Injectable, Logger } from '@nestjs/common';
import { IItemRepositoryPort } from '../ports/item-repository.port';
import { ItemAggregate } from '../domain/item.aggregate';
import { QueryRepository } from './query.repository';
import { CommandRepository } from './command.repository';
import { TransactionService } from '../../../sync';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { ItemsMapper } from './items.mapper';
import { syncTagsForCatalogItem } from './command-payload.builder';
import { TagType } from '@prisma/client';
import { ItemConcurrencyDomainException } from '../domain/item-domain.exception';

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
    includeDeleted: boolean = false,
  ): Promise<ItemAggregate | null> {
    const raw = await this.queryRepo.findById(
      userId,
      itemId,
      projectId,
      undefined,
      true,
      includeDeleted,
    );
    if (!raw) return null;

    const flattened = ItemsMapper.mapFlattenedState(raw, userId);
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

  async save(
    aggregate: ItemAggregate,
    options?: { idempotencyKey?: string; correlationId?: string },
  ): Promise<void> {
    const domainEvents = aggregate.pullDomainEvents();

    await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const existing = await tx.item.findUnique({
        where: { id: aggregate.id },
        select: { id: true, version: true, itemType: true, metadata: true },
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

      const isTypeChanged =
        domainEvents.some(
          (e) =>
            e.eventType === 'catalog.item.type_changed' ||
            (e as any).eventName === 'ItemTypeChangedDomainEvent',
        ) ||
        (existing &&
          existing.itemType &&
          existing.itemType !== aggregate.itemType);

      const metadataPayload = isTypeChanged
        ? {
            ...restFields,
            ...(aggregate.publicationTitle
              ? { publicationTitle: aggregate.publicationTitle }
              : {}),
          }
        : {
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
                  fieldMode:
                    c.fieldMode !== undefined ? Number(c.fieldMode) : 0,
                  firstName: c.firstName || '',
                  lastName: c.lastName || '',
                  fullName:
                    c.fullName ||
                    c.name ||
                    [c.firstName, c.lastName].filter(Boolean).join(' ') ||
                    '',
                  shortName: c.shortName || '',
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
                create: rawNotes.map((n: any) => {
                  const contentMd =
                    typeof n === 'string'
                      ? n
                      : n.contentMd || n.content || n.note || '';
                  const title =
                    (typeof n === 'object' && n?.title) ||
                    contentMd
                      .split(/\r?\n/)
                      .find((l: string) => l.trim().length > 0)
                      ?.trim()
                      ?.slice(0, 80) ||
                    'Imported Note';
                  return {
                    userId: aggregate.userId,
                    createdById: aggregate.userId,
                    projectId: aggregate.projectId ?? null,
                    title,
                    contentMd,
                    contentJson:
                      typeof n === 'object' && n.contentJson
                        ? n.contentJson
                        : null,
                    tags:
                      typeof n === 'object' && Array.isArray(n.tags)
                        ? n.tags
                        : [],
                  };
                }),
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
            ...(contributorsCreate ? { contributors: contributorsCreate } : {}),
            ...(collectionItemsCreate
              ? { collectionItems: collectionItemsCreate }
              : {}),
            ...(notesCreate ? { notesList: notesCreate } : {}),
          },
        });

        if (Array.isArray(rawTags) && rawTags.length > 0) {
          const defaultTagType =
            aggregate.fields.keywords?.length || aggregate.fields.labels?.length
              ? TagType.automatic
              : TagType.manual;
          await syncTagsForCatalogItem(
            tx,
            aggregate.userId,
            aggregate.id,
            rawTags,
            defaultTagType,
          );
        }
      } else {
        // Update existing item with atomic Optimistic Concurrency Control (OCC) guard
        const expectedPreviousVersion = aggregate.version - 1;
        const updateResult = await tx.item.updateMany({
          where: {
            id: aggregate.id,
            version: expectedPreviousVersion,
          },
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

        if (updateResult.count === 0) {
          const fresh = await tx.item.findUnique({
            where: { id: aggregate.id },
            select: { version: true },
          });
          throw new ItemConcurrencyDomainException(
            aggregate.id,
            fresh?.version ?? 0,
            expectedPreviousVersion,
          );
        }

        if (Array.isArray(rawTags)) {
          const defaultTagType =
            aggregate.fields.keywords?.length || aggregate.fields.labels?.length
              ? TagType.automatic
              : TagType.manual;
          await syncTagsForCatalogItem(
            tx,
            aggregate.userId,
            aggregate.id,
            rawTags,
            defaultTagType,
          );
        }

        const incomingCollectionIds = Array.isArray(rawCollectionIds)
          ? rawCollectionIds
          : _collectionId !== undefined
            ? _collectionId
              ? [_collectionId]
              : []
            : null;

        if (incomingCollectionIds !== null) {
          const uniqueIds = Array.from(
            new Set(
              incomingCollectionIds.filter(
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
                fieldMode: c.fieldMode !== undefined ? Number(c.fieldMode) : 0,
                firstName: c.firstName || '',
                lastName: c.lastName || '',
                fullName:
                  c.fullName ||
                  c.name ||
                  [c.firstName, c.lastName].filter(Boolean).join(' ') ||
                  '',
                shortName: c.shortName || '',
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
            ...(Array.isArray((event as any).updatedFields)
              ? { updatedFields: (event as any).updatedFields }
              : {}),
            ...(options?.correlationId
              ? { correlationId: options.correlationId }
              : {}),
            ...(options?.idempotencyKey
              ? { idempotencyKey: options.idempotencyKey }
              : {}),
          },
        );
      }
    });
  }

  async findMany(
    userId: string,
    options: import('../ports/item-repository.port').FindManyItemsOptions,
  ): Promise<import('../ports/item-repository.port').PaginatedItemsResult> {
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
      const flattened = ItemsMapper.mapFlattenedState(raw, userId);
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
