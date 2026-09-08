import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma, RagStatus } from '@prisma/client';
import { ItemQueryRepository } from './repositories/item-query.repository';
import { ItemCommandRepository } from './repositories/item-command.repository';
import {
  CreateCatalogItemData,
  UpdateCatalogItemData,
} from './types/items.types';
import {
  TransactionService,
  TransactionHelpers,
} from '../outbox/transaction.service';
import {
  LIBRARY_EVENT_TYPES,
  SYNC_EVENT_TYPES,
  LibraryItemSource,
  buildItemCreatedOutboxPayload,
} from '../outbox/outbox.events';
import { CursorPaginatedResult } from './dto/items.dto';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveTenantWorkspaceId } from '../../../core/utils/tenant.util';
import { normalizeTags } from '../tags/utils/tags.utils';
import { TagsService } from '../tags/tags.service';
import { CollectionsService } from '../collections/collections.service';
import { TypesService } from '../types/types.service';
import { RagIndexerProvider } from '../search/providers/rag-indexer.provider';
import { ItemsMapper } from './mappers/items.mapper';
import {
  FieldMappingChange,
  DroppedField,
  CreatorRoleChange,
  TypeConversionPreview,
  ConvertTypeOptions,
} from './types/items.types';
import {
  parseCreatorString,
  normalizeDoi,
  normalizeIsbn,
  normalizeIssn,
  cleanBannedString,
} from './utils/items.utils';
import { randomUUID } from 'crypto';
import { IItemReadPort, IItemExistencePort } from './ports/items.ports';

import type {
  UpsertSyncCatalogItemCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../common/types/sync.types';

/** Transaction context passed to write methods for composing operations within a parent transaction. */
export interface CatalogTransactionContext {
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
}

export type ItemTransactionContext = CatalogTransactionContext;

import {
  CATALOG_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
} from './constants/items.constants';
import { ItemFieldDefinition } from '../types/types.types';

function getItemFieldValue(item: Record<string, any>, key: string): any {
  if (!item) return undefined;
  if (item[key] !== undefined && item[key] !== null && item[key] !== '') {
    return item[key];
  }
  if (item.extraFields && typeof item.extraFields === 'object') {
    if (
      item.extraFields[key] !== undefined &&
      item.extraFields[key] !== null &&
      item.extraFields[key] !== ''
    ) {
      return item.extraFields[key];
    }
  }
  const alias = FIELD_ALIASES[key] || REVERSE_FIELD_ALIASES[key];
  if (alias) {
    if (item[alias] !== undefined && item[alias] !== null && item[alias] !== '') {
      return item[alias];
    }
    if (item.extraFields && typeof item.extraFields === 'object') {
      if (
        item.extraFields[alias] !== undefined &&
        item.extraFields[alias] !== null &&
        item.extraFields[alias] !== ''
      ) {
        return item.extraFields[alias];
      }
    }
  }
  const lowerKey = key.toLowerCase();
  for (const [k, v] of Object.entries(item)) {
    if (k.toLowerCase() === lowerKey && v !== undefined && v !== null && v !== '') {
      return v;
    }
  }
  if (item.extraFields && typeof item.extraFields === 'object') {
    for (const [k, v] of Object.entries(item.extraFields)) {
      if (k.toLowerCase() === lowerKey && v !== undefined && v !== null && v !== '') {
        return v;
      }
    }
  }
  return undefined;
}

function findMatchingTargetField(
  sourceKey: string,
  targetFields: ItemFieldDefinition[],
): string | undefined {
  const exact = targetFields.find((f) => f.key === sourceKey);
  if (exact) return exact.key;

  const targetAlias = FIELD_ALIASES[sourceKey] || REVERSE_FIELD_ALIASES[sourceKey];
  if (targetAlias) {
    const matched = targetFields.find((f) => f.key === targetAlias);
    if (matched) return matched.key;
  }

  const lowerSource = sourceKey.toLowerCase();
  const matchedCase = targetFields.find((f) => f.key.toLowerCase() === lowerSource);
  if (matchedCase) return matchedCase.key;

  return undefined;
}

@Injectable()
export class ItemsService implements IItemReadPort, IItemExistencePort {
  private readonly logger = new Logger(ItemsService.name);

  constructor(
    private readonly queryRepo: ItemQueryRepository,
    private readonly commandRepo: ItemCommandRepository,
    private readonly libraryTx: TransactionService,
    private readonly prisma: PrismaService,
    private readonly tagsService: TagsService,
    private readonly collectionsService: CollectionsService,
    private readonly typesService: TypesService,
    private readonly ragIndexer: RagIndexerProvider,
  ) {}

  private resolveWorkspaceId(workspaceId: string): Promise<string> {
    return resolveTenantWorkspaceId(this.prisma, workspaceId);
  }

  private mapFlattenedState(
    item: Record<string, any>,
    userId?: string,
  ): Record<string, any> | null {
    return ItemsMapper.mapFlattenedState(item, userId);
  }

  async getItem(workspaceId: string, id: string, userId?: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const item = await this.queryRepo.findById(canonicalWorkspaceId, id);
    if (!item) return null;
    return this.mapFlattenedState(item, userId);
  }

  async getFulltext(workspaceId: string, id: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.getFulltext(canonicalWorkspaceId, id);
  }

  async listItems(
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
  ): Promise<CursorPaginatedResult<any>> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const limit = Math.min(options.limit ?? 50, 100);
    const [totalCount, rawItems] = await Promise.all([
      this.queryRepo.count(canonicalWorkspaceId, options),
      this.queryRepo.findMany(canonicalWorkspaceId, {
        ...options,
        limit,
      }),
    ]);

    let hasNextPage = false;
    let nextCursor: string | undefined;

    if (rawItems.length > limit) {
      hasNextPage = true;
      rawItems.pop();
      nextCursor = rawItems[rawItems.length - 1]?.id;
    }

    const items = rawItems.map((it) =>
      this.mapFlattenedState(it, options.userId),
    );

    return {
      items,
      meta: {
        cursor: nextCursor,
        hasNextPage,
        totalCount,
      },
    };
  }

  async createItem(
    workspaceId: string,
    data: CreateCatalogItemData,
    context?: Partial<CatalogTransactionContext> & {
      source?: LibraryItemSource;
    },
  ): Promise<any> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);

    const execute = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => {
      const item = await this.commandRepo.create(
        canonicalWorkspaceId,
        data,
        tx,
      );

      await helpers.appendChange(canonicalWorkspaceId, {
        entityType: 'CatalogItem',
        entityId: item.id,
        action: 'create',
        version: item.version,
        data: item,
      });

      const payload = buildItemCreatedOutboxPayload({
        itemId: item.id,
        workspaceId: canonicalWorkspaceId,
        title: item.title,
        source: context?.source ?? 'manual',
        doi: item.doi,
      });

      await helpers.publishOutbox(
        canonicalWorkspaceId,
        item.id,
        LIBRARY_EVENT_TYPES.ITEM_CREATED,
        payload,
      );

      return ItemsMapper.toDomain(item);
    };

    if (context?.tx && context?.helpers) {
      return execute(context.tx, context.helpers);
    }

    return this.libraryTx.executeInTransaction(execute);
  }

  async updateItem(
    workspaceId: string,
    id: string,
    expectedVersion: number | undefined,
    data: UpdateCatalogItemData,
    context?: CatalogTransactionContext,
  ): Promise<any> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    if (context) {
      const updated = await this.commandRepo.update(
        canonicalWorkspaceId,
        id,
        expectedVersion,
        data,
        context.tx,
      );

      await context.helpers.appendChange(canonicalWorkspaceId, {
        entityType: 'CatalogItem',
        entityId: id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await context.helpers.publishOutbox(
        canonicalWorkspaceId,
        id,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        updated,
      );

      return ItemsMapper.toDomain(updated);
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      return this.updateItem(canonicalWorkspaceId, id, expectedVersion, data, {
        tx,
        helpers,
      });
    });
  }

  private async executePaperRagIndexing(item: any): Promise<void> {
    await this.commandRepo.updateRagStatus(item.id, {
      ragStatus: RagStatus.pending,
      ragLastAttemptAt: new Date(),
    });
    try {
      const result = await this.ragIndexer.indexPaper(item);
      await this.commandRepo.updateRagStatus(item.id, {
        ragDocId: result.docId,
        ragStatus: 'indexed',
        ragIndexedAt: new Date(),
        ragError: null,
      });
      this.logger.log(
        `Paper ${item.id} successfully indexed into Qdrant (docId: ${result.docId})`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Indexing failed';
      await this.commandRepo.updateRagStatus(item.id, {
        ragStatus: 'failed',
        ragError: message,
      });
      this.logger.error(`Failed to index paper ${item.id}: ${message}`);
    }
  }

  async reindexItem(workspaceId: string, id: string, userId: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const item = await this.queryRepo.findById(canonicalWorkspaceId, id);
    if (!item) {
      throw new NotFoundException(
        `Item ${id} not found in workspace ${canonicalWorkspaceId}`,
      );
    }

    await this.libraryTx.executeInTransaction(async (_tx, helpers) => {
      await helpers.publishOutbox(
        canonicalWorkspaceId,
        id,
        'library.item.reindexed',
        {
          itemId: id,
          workspaceId: canonicalWorkspaceId,
          userId,
        },
      );
    });

    this.executePaperRagIndexing(item).catch((err) => {
      this.logger.error(`Failed to index paper ${id}: ${err.message}`);
    });

    return {
      success: true,
      message: 'Item re-indexing started',
      itemId: id,
    };
  }

  async deleteItem(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
    context?: CatalogTransactionContext,
  ): Promise<boolean> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    if (context) {
      const deleted = await this.commandRepo.softDelete(
        canonicalWorkspaceId,
        id,
        expectedVersion,
        context.tx,
      );

      if (deleted) {
        await context.helpers.recordTombstone(canonicalWorkspaceId, {
          entityType: 'CatalogItem',
          entityId: id,
        });

        await context.helpers.publishOutbox(
          canonicalWorkspaceId,
          id,
          'library.item.deleted',
          {
            id,
            deletedAt: new Date(),
          },
        );
      }

      return deleted;
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      return this.deleteItem(canonicalWorkspaceId, id, expectedVersion, {
        tx,
        helpers,
      });
    });
  }

  async restoreItem(workspaceId: string, id: string, expectedVersion?: number) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const restored = await this.commandRepo.restore(
        canonicalWorkspaceId,
        id,
        expectedVersion,
        tx,
      );

      await helpers.appendChange(canonicalWorkspaceId, {
        entityType: 'CatalogItem',
        entityId: id,
        action: 'update',
        version: restored.version,
        data: restored,
      });

      await helpers.publishOutbox(
        canonicalWorkspaceId,
        id,
        'library.item.restored',
        {
          id,
          restoredAt: new Date(),
        },
      );

      // Normalize through mapper so response shape is consistent with
      // getItem / createItem / updateItem (creators, fileUrl, tags, etc.)
      return ItemsMapper.toDomain(restored);
    });
  }

  async purgeItem(workspaceId: string, id: string): Promise<boolean> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const purged = await this.commandRepo.purge(canonicalWorkspaceId, id, tx);

      await helpers.recordTombstone(canonicalWorkspaceId, {
        entityType: 'CatalogItem',
        entityId: id,
      });

      await helpers.publishOutbox(
        canonicalWorkspaceId,
        id,
        'library.item.purged',
        {
          id,
          purgedAt: new Date(),
        },
      );

      return purged;
    });
  }

  async getRelatedItems(workspaceId: string, itemId: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const item = await this.queryRepo.findById(canonicalWorkspaceId, itemId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const relations = await this.queryRepo.getRelations(itemId);
    return {
      relatedItems: relations,
      total: relations.length,
    };
  }

  async linkItems(
    workspaceId: string,
    sourceItemId: string,
    data: { targetItemId: string; relationType?: string; note?: string },
  ) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const sourceItem = await this.queryRepo.findById(
      canonicalWorkspaceId,
      sourceItemId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    const targetItem = await this.queryRepo.findById(
      canonicalWorkspaceId,
      data.targetItemId,
    );
    if (!targetItem) {
      throw new NotFoundException(`Target item ${data.targetItemId} not found`);
    }

    const type = data.relationType ?? 'related';
    const now = new Date().toISOString();

    const relation = {
      id: randomUUID(),
      targetItemId: data.targetItemId,
      relationType: type,
      note: data.note,
      linkedAt: now,
    };

    await this.commandRepo.putRelation(sourceItemId, relation);

    return {
      success: true,
      link: relation,
      message: `Linked "${sourceItem.title}" to "${targetItem.title}"`,
    };
  }

  async unlinkItems(
    workspaceId: string,
    sourceItemId: string,
    targetItemId: string,
  ) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const sourceItem = await this.queryRepo.findById(
      canonicalWorkspaceId,
      sourceItemId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    await this.commandRepo.removeRelation(sourceItemId, targetItemId);

    return {
      success: true,
      unlinked: true,
      message: `Removed relation between "${sourceItem.title}" and "${targetItemId}"`,
    };
  }

  async getItemSnapshot(workspaceId: string, itemId: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.getItemSnapshot(canonicalWorkspaceId, itemId);
  }

  async getItemSnapshots(workspaceId: string, itemIds: string[]) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.getItemSnapshots(canonicalWorkspaceId, itemIds);
  }

  // ── Port Implementations (IItemExistencePort & ICatalogReadPort) ────────────

  async exists(workspaceId: string, itemId: string): Promise<boolean> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.exists(canonicalWorkspaceId, itemId);
  }

  async assertExists(workspaceId: string, itemId: string): Promise<void> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.assertExists(canonicalWorkspaceId, itemId);
  }

  async existMany(
    workspaceId: string,
    itemIds: string[],
  ): Promise<Map<string, boolean>> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.existMany(canonicalWorkspaceId, itemIds);
  }

  async findById(workspaceId: string, itemId: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.findById(canonicalWorkspaceId, itemId) as any;
  }

  async findByIds(workspaceId: string, itemIds: string[]) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.findByIds(canonicalWorkspaceId, itemIds) as any;
  }

  async findByDoi(workspaceId: string, doi: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.findByDoi(canonicalWorkspaceId, doi) as any;
  }

  async findSummaryById(workspaceId: string, itemId: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.findSummaryById(canonicalWorkspaceId, itemId);
  }

  async findSummariesByIds(workspaceId: string, itemIds: string[]) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.findSummariesByIds(canonicalWorkspaceId, itemIds);
  }

  async findQualityAuditItems(workspaceId: string, limit?: number) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.findQualityAuditItems(canonicalWorkspaceId, limit);
  }

  async findDuplicateCandidateItems(workspaceId: string, limit?: number) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.queryRepo.findDuplicateCandidateItems(
      canonicalWorkspaceId,
      limit,
    );
  }

  /**
   * Sync protocol adapter: transactional upsert for a CatalogItem from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncCatalogItemCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    if (command.existingId) {
      const existing = await tx.catalogItem.findUnique({
        where: { id: command.existingId },
      });

      if (!existing) {
        throw new NotFoundException(
          `Catalog item ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      if (existing.workspaceId !== command.workspaceId) {
        throw new ForbiddenException(
          `Catalog item ${command.existingId} does not belong to workspace ${command.workspaceId}`,
        );
      }

      const existingItemTags = await tx.catalogItemTag.findMany({
        where: { catalogItemId: command.existingId },
        include: { tag: true },
      });
      const existingTagNames = existingItemTags.map((it) => it.tag.name);
      const mergedTags = normalizeTags([
        ...existingTagNames,
        ...(command.tags || []),
      ]);

      const updated = await tx.catalogItem.update({
        where: { id: command.existingId },
        data: {
          title: command.title,
          abstract: command.abstract,
          year: command.year,
          doi: command.doi,
          citationKey: command.citationKey,
          publicationTitle: command.publicationTitle,
          volume: command.volume,
          issue: command.issue,
          pages: command.pages,
          issn: command.issn,
          isbn: command.isbn,
          url: command.url,
          itemType: command.itemType,
          publicationDate: command.publicationDate,
          journalAbbr: command.journalAbbr,
          publisher: command.publisher,
          place: command.place,
          series: command.series,
          seriesTitle: command.seriesTitle,
          seriesText: command.seriesText,
          rights: command.rights,
          license: command.license,
          archive: command.archive,
          archiveLocation: command.archiveLocation,
          libraryCatalog: command.libraryCatalog,
          callNumber: command.callNumber,
          language: command.language,
          extra:
            command.extra || command.extraFields || command.seriesNumber
              ? JSON.stringify({
                  ...(command.extra ? { _rawExtra: command.extra } : {}),
                  ...(command.seriesNumber
                    ? { seriesNumber: command.seriesNumber }
                    : {}),
                  ...(command.extraFields || {}),
                })
              : undefined,
          version: { increment: 1 },
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'CatalogItem',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: { title: command.title },
      });

      await this.tagsService.syncTagsToItem(
        tx,
        command.workspaceId,
        updated.id,
        mergedTags,
      );

      // Sync contributors (authors & creators)
      if (command.creators && command.creators.length > 0) {
        await tx.catalogContributor.deleteMany({
          where: { catalogItemId: updated.id },
        });
        await tx.catalogContributor.createMany({
          data: command.creators.map((c: any, index: number) => ({
            catalogItemId: updated.id,
            creatorType: c.creatorType || 'author',
            firstName: c.firstName || '',
            lastName: c.lastName || '',
            fullName:
              c.fullName ||
              c.name ||
              [c.firstName, c.lastName].filter(Boolean).join(' ') ||
              '',
            orderIndex: c.orderIndex !== undefined ? c.orderIndex : index,
          })),
        });
      } else if (command.authors && command.authors.length > 0) {
        await tx.catalogContributor.deleteMany({
          where: { catalogItemId: updated.id },
        });
        await tx.catalogContributor.createMany({
          data: command.authors.map((authorName: string, index: number) => {
            const parsed = parseCreatorString(authorName, index);
            return {
              catalogItemId: updated.id,
              creatorType: parsed.creatorType,
              firstName: parsed.firstName,
              lastName: parsed.lastName,
              fullName: parsed.fullName,
              orderIndex: parsed.orderIndex,
            };
          }),
        });
      }

      // Sync collections (Delegated to CollectionsService)
      if (
        command.collectionIds !== undefined ||
        command.collectionId !== undefined
      ) {
        const rawTargetCollectionIds = [
          ...(Array.isArray(command.collectionIds)
            ? command.collectionIds
            : []),
          ...(command.collectionId ? [command.collectionId] : []),
        ];
        await this.collectionsService.syncCollectionsToItem(
          tx,
          command.workspaceId,
          updated.id,
          rawTargetCollectionIds,
        );
      }

      // Sync identifiers
      const cleanSyncDoi =
        normalizeDoi(cleanBannedString(command.doi)) ||
        cleanBannedString(command.doi);
      if (cleanSyncDoi) {
        await tx.catalogIdentifier.deleteMany({
          where: { catalogItemId: updated.id, type: 'doi' },
        });
        await tx.catalogIdentifier.create({
          data: {
            catalogItemId: updated.id,
            type: 'doi',
            value: cleanSyncDoi,
            canonicalUri: `https://doi.org/${cleanSyncDoi}`,
          },
        });
      }
      const cleanSyncIsbn =
        normalizeIsbn(cleanBannedString(command.isbn)) ||
        cleanBannedString(command.isbn);
      if (cleanSyncIsbn) {
        await tx.catalogIdentifier.deleteMany({
          where: { catalogItemId: updated.id, type: 'isbn' },
        });
        await tx.catalogIdentifier.create({
          data: {
            catalogItemId: updated.id,
            type: 'isbn',
            value: cleanSyncIsbn,
            canonicalUri: `urn:isbn:${cleanSyncIsbn}`,
          },
        });
      }
      const cleanSyncIssn =
        normalizeIssn(cleanBannedString(command.issn)) ||
        cleanBannedString(command.issn);
      if (cleanSyncIssn) {
        await tx.catalogIdentifier.deleteMany({
          where: { catalogItemId: updated.id, type: 'issn' },
        });
        await tx.catalogIdentifier.create({
          data: {
            catalogItemId: updated.id,
            type: 'issn',
            value: cleanSyncIssn,
            canonicalUri: `urn:issn:${cleanSyncIssn}`,
          },
        });
      }

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      const newTags = command.tags ? normalizeTags(command.tags) : [];
      const cleanCreateDoi =
        normalizeDoi(cleanBannedString(command.doi)) ||
        cleanBannedString(command.doi) ||
        '';
      const cleanCreateIsbn =
        normalizeIsbn(cleanBannedString(command.isbn)) ||
        cleanBannedString(command.isbn) ||
        '';
      const cleanCreateIssn =
        normalizeIssn(cleanBannedString(command.issn)) ||
        cleanBannedString(command.issn) ||
        '';

      const created = await tx.catalogItem.create({
        data: {
          workspaceId: command.workspaceId,
          uploadedById: command.userId,
          title: command.title,
          abstract: command.abstract,
          year: command.year,
          doi: cleanCreateDoi,
          citationKey: command.citationKey,
          publicationTitle: command.publicationTitle,
          volume: command.volume,
          issue: command.issue,
          pages: command.pages,
          issn: cleanCreateIssn,
          isbn: cleanCreateIsbn,
          url: command.url,
          itemType: command.itemType,
          publicationDate: command.publicationDate,
          journalAbbr: command.journalAbbr,
          publisher: command.publisher,
          place: command.place,
          series: command.series,
          seriesTitle: command.seriesTitle,
          seriesText: command.seriesText,
          rights: command.rights,
          license: command.license,
          archive: command.archive,
          archiveLocation: command.archiveLocation,
          libraryCatalog: command.libraryCatalog,
          callNumber: command.callNumber,
          language: command.language,
          extra:
            command.extra || command.extraFields || command.seriesNumber
              ? JSON.stringify({
                  ...(command.extra ? { _rawExtra: command.extra } : {}),
                  ...(command.seriesNumber
                    ? { seriesNumber: command.seriesNumber }
                    : {}),
                  ...(command.extraFields || {}),
                })
              : undefined,
          version: 1,
        },
      });

      await this.tagsService.syncTagsToItem(
        tx,
        command.workspaceId,
        created.id,
        newTags,
      );

      // Sync contributors (authors & creators)
      if (command.creators && command.creators.length > 0) {
        await tx.catalogContributor.createMany({
          data: command.creators.map((c: any, index: number) => ({
            catalogItemId: created.id,
            creatorType: c.creatorType || 'author',
            firstName: c.firstName || '',
            lastName: c.lastName || '',
            fullName:
              c.fullName ||
              c.name ||
              [c.firstName, c.lastName].filter(Boolean).join(' ') ||
              '',
            orderIndex: c.orderIndex !== undefined ? c.orderIndex : index,
          })),
        });
      } else if (command.authors && command.authors.length > 0) {
        await tx.catalogContributor.createMany({
          data: command.authors.map((authorName: string, index: number) => {
            const parsed = parseCreatorString(authorName, index);
            return {
              catalogItemId: created.id,
              creatorType: parsed.creatorType,
              firstName: parsed.firstName,
              lastName: parsed.lastName,
              fullName: parsed.fullName,
              orderIndex: parsed.orderIndex,
            };
          }),
        });
      }

      // Sync collections (Delegated to CollectionsService)
      const rawNewCollectionIds = [
        ...(Array.isArray(command.collectionIds) ? command.collectionIds : []),
        ...(command.collectionId ? [command.collectionId] : []),
      ];
      if (rawNewCollectionIds.length > 0) {
        await this.collectionsService.syncCollectionsToItem(
          tx,
          command.workspaceId,
          created.id,
          rawNewCollectionIds,
        );
      }

      // Sync identifiers
      if (cleanCreateDoi) {
        await tx.catalogIdentifier.create({
          data: {
            catalogItemId: created.id,
            type: 'doi',
            value: cleanCreateDoi,
            canonicalUri: `https://doi.org/${cleanCreateDoi}`,
          },
        });
      }
      if (cleanCreateIsbn) {
        await tx.catalogIdentifier.create({
          data: {
            catalogItemId: created.id,
            type: 'isbn',
            value: cleanCreateIsbn,
            canonicalUri: `urn:isbn:${cleanCreateIsbn}`,
          },
        });
      }
      if (cleanCreateIssn) {
        await tx.catalogIdentifier.create({
          data: {
            catalogItemId: created.id,
            type: 'issn',
            value: cleanCreateIssn,
            canonicalUri: `urn:issn:${cleanCreateIssn}`,
          },
        });
      }

      await helpers.appendChange(command.workspaceId, {
        entityType: 'CatalogItem',
        entityId: created.id,
        action: 'create',
        version: 1,
        data: { title: command.title },
      });

      await helpers.publishOutbox(
        command.workspaceId,
        created.id,
        LIBRARY_EVENT_TYPES.ITEM_CREATED,
        buildItemCreatedOutboxPayload({
          itemId: created.id,
          workspaceId: command.workspaceId,
          title: created.title,
          source: 'external_sync',
        }),
      );

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  /**
   * Sync protocol adapter: transactional soft-delete for a CatalogItem from an external sync batch.
   */
  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const {
      workspaceId,
      entityId,
      reason,
      publishOutboxEventType,
      publishOutboxPayload,
    } = command;
    const existing = await tx.catalogItem.findUnique({
      where: { id: entityId },
    });
    if (!existing) return;

    if (existing.workspaceId !== workspaceId) {
      throw new ForbiddenException(
        `Catalog item ${entityId} does not belong to workspace ${workspaceId}`,
      );
    }

    await tx.catalogItem.update({
      where: { id: entityId },
      data: { deletedAt: new Date() },
    });
    await helpers.appendChange(workspaceId, {
      entityType: 'CatalogItem',
      entityId,
      action: 'delete',
      version: existing.version + 1,
      data: { reason },
    });
    await helpers.recordTombstone(workspaceId, {
      entityType: 'CatalogItem',
      entityId,
    });
    await helpers.publishOutbox(
      workspaceId,
      entityId,
      publishOutboxEventType ?? 'library.item.deleted',
      (publishOutboxPayload ?? { itemId: entityId, reason }) as any,
    );
  }

  /**
   * Generates a deterministic preview of item-type conversion without modifying DB state.
   */
  previewTypeConversion(
    rawItem: Record<string, any>,
    targetType: string,
    options: { retainUnmappedInExtra?: boolean } = {},
  ): TypeConversionPreview {
    const item = ItemsMapper.toDomain(rawItem);
    const sourceType = item.itemType || item.type || 'journalArticle';

    if (!this.typesService.isValidType(targetType)) {
      throw new BadRequestException(`Invalid target itemType: ${targetType}`);
    }

    if (!this.typesService.isBibliographic(sourceType)) {
      throw new BadRequestException(
        `Cannot convert non-bibliographic item type: ${sourceType}`,
      );
    }

    if (!this.typesService.isBibliographic(targetType)) {
      throw new BadRequestException(
        `Cannot convert to special non-bibliographic item type: ${targetType}`,
      );
    }

    if (sourceType === targetType) {
      return {
        sourceType,
        targetType,
        preservedFields: this.typesService
          .getOrderedFields(sourceType)
          .map((f) => f.key),
        mappedFields: [],
        droppedFields: [],
        creatorChanges: (item.creators || []).map(
          (c: Record<string, unknown>) => ({
            creator: c,
            fromRole: c.creatorType || 'author',
            toRole: c.creatorType || 'author',
            reason: 'preserved' as const,
          }),
        ),
        projectedItem: { ...item },
        unmappedRetained: {},
        hasLoss: false,
      };
    }

    const sourceFields = this.typesService.getOrderedFields(sourceType);
    const targetFields = this.typesService.getOrderedFields(targetType);
    const targetFieldKeys = new Set(targetFields.map((f) => f.key));
    const sourceLabelMap = new Map(sourceFields.map((f) => [f.key, f.label]));

    const preservedFields: string[] = [];
    const mappedFields: FieldMappingChange[] = [];
    const droppedFields: DroppedField[] = [];
    const unmappedRetained: Record<string, any> = {};

    const projectedItem: Record<string, any> = {
      ...item,
      itemType: targetType,
      type: targetType,
    };

    const sourceValues: Record<string, any> = {};
    for (const field of sourceFields) {
      const val = getItemFieldValue(item, field.key);
      if (val !== undefined && val !== null && val !== '') {
        sourceValues[field.key] = val;
      }
    }

    const persistentAcademicKeys = [
      'title',
      'abstract',
      'abstractNote',
      'date',
      'year',
      'url',
      'DOI',
      'doi',
      'ISBN',
      'isbn',
      'ISSN',
      'issn',
      'PMID',
      'pmid',
      'PMCID',
      'pmcid',
      'archiveID',
      'archiveId',
      'arxivId',
      'citationCount',
      'referenceCount',
      'openAccessPdfUrl',
      'language',
      'shortTitle',
      'rights',
      'license',
      'extra',
      'citationKey',
    ];
    for (const k of persistentAcademicKeys) {
      const val = getItemFieldValue(item, k);
      if (val !== undefined && val !== null && val !== '') {
        const canonicalKey = FIELD_ALIASES[k] ? k : (REVERSE_FIELD_ALIASES[k] || k);
        if (sourceValues[canonicalKey] === undefined && sourceValues[k] === undefined) {
          sourceValues[canonicalKey] = val;
        }
      }
    }

    for (const field of sourceFields) {
      const matched = findMatchingTargetField(field.key, targetFields);
      if (
        !matched &&
        field.key !== 'title' &&
        field.key !== 'abstract' &&
        field.key !== 'abstractNote' &&
        field.key !== 'url' &&
        field.key !== 'doi' &&
        field.key !== 'DOI'
      ) {
        delete projectedItem[field.key];
      }
    }

    const newExtraFields: Record<string, any> = { ...(item.extraFields || {}) };

    if (sourceType === 'book' && targetType === 'bookSection') {
      if (sourceValues.title) {
        projectedItem.bookTitle = sourceValues.title;
        projectedItem.title = '';
        mappedFields.push({
          fromField: 'title',
          toField: 'bookTitle',
          value: sourceValues.title,
          rule: 'special-rule',
        });
        delete sourceValues.title;
      }
      delete projectedItem.shortTitle;
      delete sourceValues.shortTitle;
    } else if (sourceType === 'bookSection' && targetType === 'book') {
      if (sourceValues.bookTitle) {
        projectedItem.title = sourceValues.bookTitle;
        mappedFields.push({
          fromField: 'bookTitle',
          toField: 'title',
          value: sourceValues.bookTitle,
          rule: 'special-rule',
        });
        delete sourceValues.bookTitle;
      }
      delete projectedItem.shortTitle;
      delete sourceValues.shortTitle;
    }

    for (const [sField, val] of Object.entries(sourceValues)) {
      const matchedTargetKey = findMatchingTargetField(sField, targetFields);
      if (matchedTargetKey) {
        projectedItem[matchedTargetKey] = val;
        const dbCol = FIELD_ALIASES[matchedTargetKey];
        if (dbCol) projectedItem[dbCol] = val;
        preservedFields.push(matchedTargetKey);
      } else {
        const resolved = this.typesService.resolveBaseFieldMapping(
          sourceType,
          targetType,
          sField,
        );

        if (
          resolved?.targetField &&
          targetFieldKeys.has(resolved.targetField)
        ) {
          projectedItem[resolved.targetField] = val;
          const dbCol = FIELD_ALIASES[resolved.targetField];
          if (dbCol) projectedItem[dbCol] = val;
          mappedFields.push({
            fromField: sField,
            toField: resolved.targetField,
            value: val,
            rule: 'base-semantic',
          });
        } else {
          const isPersistentCol =
            CATALOG_COLUMN_METADATA_FIELDS.has(sField) ||
            CATALOG_COLUMN_METADATA_FIELDS.has(FIELD_ALIASES[sField]);

          if (
            isPersistentCol &&
            [
              'doi',
              'DOI',
              'arxivId',
              'archiveID',
              'archiveId',
              'pmid',
              'PMID',
              'pmcid',
              'PMCID',
              'citationCount',
              'referenceCount',
              'openAccessPdfUrl',
              'url',
            ].includes(sField)
          ) {
            projectedItem[sField] = val;
            const dbCol = FIELD_ALIASES[sField];
            if (dbCol) projectedItem[dbCol] = val;
            preservedFields.push(sField);
          } else {
            droppedFields.push({
              field: sField,
              label: sourceLabelMap.get(sField) || sField,
              value: val,
            });
            unmappedRetained[sField] = val;

            if (options.retainUnmappedInExtra !== false) {
              newExtraFields[`__unmapped_${sourceType}_${sField}`] = val;
            }
          }
        }
      }
    }

    projectedItem.extraFields = newExtraFields;

    const validCreatorRoles = new Set(
      this.typesService
        .getValidCreatorTypes(targetType)
        .map((c) => c.creatorType),
    );
    const targetPrimaryCreator =
      this.typesService.getPrimaryCreatorType(targetType);
    const creatorChanges: CreatorRoleChange[] = [];

    const projectedCreators = (item.creators || []).map(
      (c: Record<string, unknown>, index: number) => {
        const fromRole = (c.creatorType as string) || 'author';
        let toRole: string = fromRole;
        let reason: 'preserved' | 'primary-fallback' | 'secondary-fallback' =
          'preserved';

        if (!validCreatorRoles.has(fromRole)) {
          if (index === 0 && validCreatorRoles.has(targetPrimaryCreator)) {
            toRole = targetPrimaryCreator;
            reason = 'primary-fallback';
          } else if (validCreatorRoles.has('contributor')) {
            toRole = 'contributor';
            reason = 'secondary-fallback';
          } else {
            toRole = targetPrimaryCreator;
            reason = 'primary-fallback';
          }
        }

        creatorChanges.push({ creator: c, fromRole, toRole, reason });
        return { ...c, creatorType: toRole };
      },
    );

    projectedItem.creators = projectedCreators;

    const hasLoss =
      droppedFields.length > 0 ||
      creatorChanges.some((c) => c.reason !== 'preserved');

    return {
      sourceType,
      targetType,
      preservedFields,
      mappedFields,
      droppedFields,
      creatorChanges,
      projectedItem,
      unmappedRetained,
      hasLoss,
    };
  }

  /**
   * Executes type conversion transactionally in the database.
   */
  async convertItemType(
    workspaceId: string,
    itemId: string,
    targetType: string,
    options: ConvertTypeOptions = {},
    tx?: Prisma.TransactionClient,
  ) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const existing = await this.queryRepo.findById(
      canonicalWorkspaceId,
      itemId,
      tx,
    );
    if (!existing) {
      throw new NotFoundException(
        `Item ${itemId} not found in workspace ${canonicalWorkspaceId}`,
      );
    }

    const preview = this.previewTypeConversion(existing, targetType, {
      retainUnmappedInExtra: options.retainUnmappedInExtra ?? true,
    });

    const projected = preview.projectedItem;

    const targetFields = this.typesService.getOrderedFields(targetType);
    const dynamicExtraFields: Record<string, any> = {
      ...(projected.extraFields || {}),
    };

    for (const field of targetFields) {
      const val = getItemFieldValue(projected, field.key);
      if (
        val !== undefined &&
        val !== null &&
        val !== '' &&
        !CATALOG_COLUMN_METADATA_FIELDS.has(field.key) &&
        !CATALOG_COLUMN_METADATA_FIELDS.has(FIELD_ALIASES[field.key])
      ) {
        dynamicExtraFields[field.key] = val;
      }
    }

    const updatePayload: Record<string, any> = {
      itemType: targetType,
      type: targetType,
      creators: projected.creators ?? (existing as any).creators,
      extraFields: dynamicExtraFields,
    };

    const droppedSet = new Set(
      preview.droppedFields.map((d) => d.field.toLowerCase()),
    );

    for (const col of CATALOG_COLUMN_METADATA_FIELDS) {
      if (FIELD_ALIASES[col] && FIELD_ALIASES[col] !== col) continue;

      const colLower = col.toLowerCase();
      if (droppedSet.has(colLower)) {
        updatePayload[col] = '';
      } else {
        const val =
          getItemFieldValue(projected, col) ?? (existing as any)[col];
        if (val !== undefined) {
          updatePayload[col] = val;
        }
      }
    }

    const updated = await this.commandRepo.update(
      canonicalWorkspaceId,
      itemId,
      options.expectedVersion,
      updatePayload,
      tx,
    );

    return {
      success: true,
      item: ItemsMapper.toDomain(updated),
      conversionReport: preview,
    };
  }
}

export const CatalogService = ItemsService;
export type CatalogService = ItemsService;
