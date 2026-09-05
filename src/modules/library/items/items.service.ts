import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ItemsRepository,
  CreateCatalogItemData,
  UpdateCatalogItemData,
} from './items.repository';
import { TransactionService, TransactionHelpers } from '../outbox/transaction.service';
import {
  LIBRARY_EVENT_TYPES,
  SYNC_EVENT_TYPES,
  LibraryItemSource,
  buildItemCreatedOutboxPayload,
} from '../outbox/outbox.events';
import { CursorPaginatedResult } from './items.dto';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveTenantWorkspaceId } from '../../../core/utils/tenant.util';
import { normalizeTags } from '../tags/utils/tags.utils';
import { TagsService } from '../tags/tags.service';
import { CollectionsService } from '../collections/collections.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { NotesService } from '../notes/notes.service';
import { ReadingService } from '../reading/reading.service';
import { ItemsMapper } from './items.mapper';
import { parseCreatorString } from './creator-parser.util';
import {
  normalizeDoi,
  normalizeIsbn,
  normalizeIssn,
} from './items.utils';
import { cleanBannedString } from './text-cleaner.util';
import { randomUUID } from 'crypto';
import type {
  UpsertSyncCatalogItemCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../sync/ports/sync.port';

/** Transaction context passed to write methods for composing operations within a parent transaction. */
export interface CatalogTransactionContext {
  tx: Prisma.TransactionClient;
  helpers: TransactionHelpers;
}

export type ItemTransactionContext = CatalogTransactionContext;

@Injectable()
export class ItemsService {
  private readonly logger = new Logger(ItemsService.name);

  constructor(
    private readonly catalogRepo: ItemsRepository,
    private readonly libraryTx: TransactionService,
    private readonly prisma: PrismaService,
    private readonly tagsService: TagsService,
    private readonly collectionsService: CollectionsService,
    private readonly attachmentsService: AttachmentsService,
    private readonly notesService: NotesService,
    private readonly readingService: ReadingService,
  ) {}

  private resolveWorkspaceId(workspaceId: string): Promise<string> {
    return resolveTenantWorkspaceId(this.prisma, workspaceId);
  }

  private mapFlattenedState(
    item: Record<string, any>,
    userId?: string,
  ): Record<string, any> | null {
    if (!item) return null;
    const normalized = ItemsMapper.toDomain(item);
    const userState = Array.isArray(normalized.userStates)
      ? normalized.userStates[0]
      : undefined;
    const { userStates: _userStates, ...rest } = normalized;
    return {
      ...rest,
      readStatus: userState?.readStatus ?? 'unread',
      rating: userState?.rating ?? 0,
      lastReadAt: userState?.lastReadAt
        ? userState.lastReadAt.toISOString()
        : null,
    };
  }

  async getItem(workspaceId: string, id: string, userId?: string) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const item = await this.catalogRepo.findById(wsId, id);
    if (!item) return null;
    return this.mapFlattenedState(item, userId);
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
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const limit = Math.min(options.limit ?? 50, 100);
    const [totalCount, rawItems] = await Promise.all([
      this.catalogRepo.count(wsId, options),
      this.catalogRepo.findMany(wsId, {
        ...options,
        limit,
      }),
    ]);

    let hasNextPage = false;
    let nextCursor: string | undefined;

    if (rawItems.length > limit) {
      hasNextPage = true;
      const popped = rawItems.pop();
      nextCursor = popped?.id;
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
    context?: Partial<CatalogTransactionContext> & { source?: LibraryItemSource },
  ): Promise<any> {
    const wsId = await this.resolveWorkspaceId(workspaceId);

    const execute = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => {
      const item = await this.catalogRepo.create(wsId, data, tx);

      await helpers.appendChange(wsId, {
        entityType: 'CatalogItem',
        entityId: item.id,
        action: 'create',
        version: item.version,
        data: item,
      });

      const payload = buildItemCreatedOutboxPayload({
        itemId: item.id,
        workspaceId: wsId,
        title: item.title,
        source: context?.source ?? 'manual',
        doi: item.doi,
      });

      await helpers.publishOutbox(
        wsId,
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
    const wsId = await this.resolveWorkspaceId(workspaceId);
    if (context) {
      const updated = await this.catalogRepo.update(
        wsId,
        id,
        expectedVersion,
        data,
        context.tx,
      );

      await context.helpers.appendChange(wsId, {
        entityType: 'CatalogItem',
        entityId: id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await context.helpers.publishOutbox(
        wsId,
        id,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        updated,
      );

      return ItemsMapper.toDomain(updated);
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      return this.updateItem(wsId, id, expectedVersion, data, {
        tx,
        helpers,
      });
    });
  }

  async reindexItem(workspaceId: string, id: string, userId: string) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const item = await this.catalogRepo.findById(wsId, id);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in workspace ${wsId}`);
    }

    await this.libraryTx.executeInTransaction(async (_tx, helpers) => {
      await helpers.publishOutbox(wsId, id, 'library.item.reindexed', {
        itemId: id,
        workspaceId: wsId,
        userId,
      });
    });

    return {
      success: true,
      message: 'Item re-indexed successfully',
      itemId: id,
    };
  }

  async deleteItem(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
    context?: CatalogTransactionContext,
  ): Promise<boolean> {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    if (context) {
      const deleted = await this.catalogRepo.softDelete(
        wsId,
        id,
        expectedVersion,
        context.tx,
      );

      if (deleted) {
        await context.helpers.recordTombstone(wsId, {
          entityType: 'CatalogItem',
          entityId: id,
        });

        await context.helpers.publishOutbox(wsId, id, 'library.item.deleted', {
          id,
          deletedAt: new Date(),
        });
      }

      return deleted;
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      return this.deleteItem(wsId, id, expectedVersion, { tx, helpers });
    });
  }


  async restoreItem(workspaceId: string, id: string, expectedVersion?: number) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const restored = await this.catalogRepo.restore(
        wsId,
        id,
        expectedVersion,
        tx,
      );

      await helpers.appendChange(wsId, {
        entityType: 'CatalogItem',
        entityId: id,
        action: 'update',
        version: restored.version,
        data: restored,
      });

      await helpers.publishOutbox(wsId, id, 'library.item.restored', {
        id,
        restoredAt: new Date(),
      });

      // Normalize through mapper so response shape is consistent with
      // getItem / createItem / updateItem (creators, fileUrl, tags, etc.)
      return ItemsMapper.toDomain(restored);
    });
  }

  async purgeItem(workspaceId: string, id: string): Promise<boolean> {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const purged = await this.catalogRepo.purge(wsId, id, tx);

      await helpers.recordTombstone(wsId, {
        entityType: 'CatalogItem',
        entityId: id,
      });

      await helpers.publishOutbox(wsId, id, 'library.item.purged', {
        id,
        purgedAt: new Date(),
      });

      return purged;
    });
  }

  async getRelatedItems(workspaceId: string, itemId: string) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const item = await this.catalogRepo.findById(wsId, itemId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const relations = await this.catalogRepo.getRelations(itemId);
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
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const sourceItem = await this.catalogRepo.findById(wsId, sourceItemId);
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    const targetItem = await this.catalogRepo.findById(wsId, data.targetItemId);
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

    await this.catalogRepo.putRelation(sourceItemId, relation);

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
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const sourceItem = await this.catalogRepo.findById(wsId, sourceItemId);
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    await this.catalogRepo.removeRelation(sourceItemId, targetItemId);

    return {
      success: true,
      unlinked: true,
      message: `Removed relation between "${sourceItem.title}" and "${targetItemId}"`,
    };
  }

  async getItemSnapshot(workspaceId: string, itemId: string) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    return this.catalogRepo.getItemSnapshot(wsId, itemId);
  }

  async getItemSnapshots(workspaceId: string, itemIds: string[]) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    return this.catalogRepo.getItemSnapshots(wsId, itemIds);
  }


  /**
   * Synthesizes and extracts literature notes from PDF highlights and annotations.
   */
  async extractNotesFromAnnotations(
    workspaceId: string,
    itemId: string,
    userId: string,
  ) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const item = await this.catalogRepo.findById(wsId, itemId);
    if (!item) {
      throw new NotFoundException(
        `Item ${itemId} not found in workspace ${wsId}`,
      );
    }

    const attachments = await this.prisma.catalogAttachment.findMany({
      where: { catalogItemId: itemId },
      select: { id: true, filename: true },
    });

    const attachmentIds = attachments.map((a: { id: string }) => a.id);
    const annotations =
      attachmentIds.length > 0
        ? await this.prisma.annotation.findMany({
            where: { attachmentId: { in: attachmentIds }, deletedAt: null },
            orderBy: [{ pageIndex: 'asc' }, { createdAt: 'asc' }],
          })
        : [];

    if (annotations.length === 0) {
      return {
        success: true,
        totalExtracted: 0,
        message: 'No annotations found for this item',
      };
    }

    const lines: string[] = [
      `# Literature Notes: ${item.title || 'Untitled'}`,
      '',
      `**Authors:** ${Array.isArray(item.contributors) ? item.contributors.map((c: any) => c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim()).join(', ') : 'Unknown'}  `,
      `**Year:** ${item.year || 'N/A'} | **DOI:** ${item.doi || 'N/A'}`,
      '',
      '---',
      '',
      '## Extracted Highlights & Annotations',
      '',
    ];

    let currentPage = -1;
    for (const ann of annotations) {
      if (ann.pageIndex !== currentPage) {
        currentPage = ann.pageIndex;
        lines.push(`### Page ${currentPage + 1}`);
        lines.push('');
      }

      if (ann.quoteText) {
        lines.push(`> ${ann.quoteText.trim().replace(/\n+/g, '\n> ')}`);
        lines.push('');
      }

      if (ann.comment) {
        lines.push(`**Note:** ${ann.comment.trim()}`);
        lines.push('');
      }
    }

    const markdown = lines.join('\n');

    const note = await this.notesService.createNote(wsId, {
      itemId,
      title: `Literature Notes — ${item.title?.slice(0, 50) || 'Untitled'}`,
      contentMd: markdown,
      contentJson: {
        type: 'doc',
        content: [{ type: 'paragraph', text: markdown }],
      },
      createdById: userId || 'system',
      tags: ['literature-note', 'highlights'],
    });

    return {
      success: true,
      totalExtracted: annotations.length,
      literatureNote: note,
    };
  }

  // ── Port Implementations (IItemExistencePort & ICatalogReadPort) ────────────

  async exists(workspaceId: string, itemId: string): Promise<boolean> {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const count = await this.prisma.catalogItem.count({
      where: { id: itemId, workspaceId: wsId, deletedAt: null },
    });
    return count > 0;
  }

  async assertExists(workspaceId: string, itemId: string): Promise<void> {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const isPresent = await this.exists(wsId, itemId);
    if (!isPresent) {
      throw new NotFoundException(
        `Item ${itemId} not found in workspace ${wsId}`,
      );
    }
  }

  async existMany(
    workspaceId: string,
    itemIds: string[],
  ): Promise<Map<string, boolean>> {
    if (itemIds.length === 0) return new Map();
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const found = await this.prisma.catalogItem.findMany({
      where: { id: { in: itemIds }, workspaceId: wsId, deletedAt: null },
      select: { id: true },
    });
    const foundSet = new Set(found.map((it: { id: string }) => it.id));
    const result = new Map<string, boolean>();
    for (const id of itemIds) {
      result.set(id, foundSet.has(id));
    }
    return result;
  }

  async findSummaryById(workspaceId: string, itemId: string) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const item = await this.prisma.catalogItem.findFirst({
      where: { id: itemId, workspaceId: wsId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        itemType: true,
        year: true,
        doi: true,
        contributors: {
          where: { creatorType: 'author' },
          select: { fullName: true, firstName: true, lastName: true },
          orderBy: { orderIndex: 'asc' },
          take: 3,
        },
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!item) return null;
    return {
      id: item.id,
      workspaceId: item.workspaceId,
      title: item.title,
      itemType: item.itemType || undefined,
      year: item.year,
      doi: item.doi || null,
      primaryAuthors: item.contributors.map(
        (c) => c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      ),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  async findSummariesByIds(workspaceId: string, itemIds: string[]) {
    if (itemIds.length === 0) return [];
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const items = await this.prisma.catalogItem.findMany({
      where: { id: { in: itemIds }, workspaceId: wsId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        itemType: true,
        year: true,
        doi: true,
        contributors: {
          where: { creatorType: 'author' },
          select: { fullName: true, firstName: true, lastName: true },
          orderBy: { orderIndex: 'asc' },
          take: 3,
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    return items.map((item) => ({
      id: item.id,
      workspaceId: item.workspaceId,
      title: item.title,
      itemType: item.itemType || undefined,
      year: item.year,
      doi: item.doi || null,
      primaryAuthors: item.contributors.map(
        (c) => c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      ),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
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
                  ...(command.seriesNumber ? { seriesNumber: command.seriesNumber } : {}),
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

      // Sync collections
      if (
        command.collectionIds !== undefined ||
        command.collectionId !== undefined
      ) {
        const rawTargetColIds = [
          ...(Array.isArray(command.collectionIds)
            ? command.collectionIds
            : []),
          ...(command.collectionId ? [command.collectionId] : []),
        ].filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0,
        );
        const targetColIds = Array.from(new Set(rawTargetColIds));

        // Delete unlinked collection associations
        await tx.collectionItem.deleteMany({
          where: {
            catalogItemId: updated.id,
            ...(targetColIds.length > 0
              ? { collectionId: { notIn: targetColIds } }
              : {}),
          },
        });

        for (let i = 0; i < targetColIds.length; i++) {
          const colId = targetColIds[i];
          const collectionExists = await tx.collection.findFirst({
            where: { id: colId, workspaceId: command.workspaceId },
          });
          if (collectionExists) {
            const existingLink = await tx.collectionItem.findFirst({
              where: { collectionId: colId, catalogItemId: updated.id },
            });
            if (!existingLink) {
              await tx.collectionItem.create({
                data: {
                  collectionId: colId,
                  catalogItemId: updated.id,
                  sortOrder: i,
                },
              });
            }
          }
        }
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
                  ...(command.seriesNumber ? { seriesNumber: command.seriesNumber } : {}),
                  ...(command.extraFields || {}),
                })
              : undefined,
          version: 1,
        },
      });

      await this.tagsService.syncTagsToItem(tx, command.workspaceId, created.id, newTags);

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

      // Sync collections
      const rawNewColIds = [
        ...(Array.isArray(command.collectionIds) ? command.collectionIds : []),
        ...(command.collectionId ? [command.collectionId] : []),
      ].filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      );
      const newColIds = Array.from(new Set(rawNewColIds));
      if (newColIds.length > 0) {
        for (let i = 0; i < newColIds.length; i++) {
          const colId = newColIds[i];
          const collectionExists = await tx.collection.findFirst({
            where: { id: colId, workspaceId: command.workspaceId },
          });
          if (collectionExists) {
            const existingLink = await tx.collectionItem.findFirst({
              where: { collectionId: colId, catalogItemId: created.id },
            });
            if (!existingLink) {
              await tx.collectionItem.create({
                data: {
                  collectionId: colId,
                  catalogItemId: created.id,
                  sortOrder: i,
                },
              });
            }
          }
        }
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
}

export const CatalogService = ItemsService;
export type CatalogService = ItemsService;
