import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CatalogRepository,
  CreateCatalogItemData,
  UpdateCatalogItemData,
} from './catalog.repository';
import { LibraryTransactionService } from '../sync/library-transaction.service';
import {
  LIBRARY_EVENT_TYPES,
  buildItemCreatedOutboxPayload,
} from '../sync/library-event-catalog';
import { CursorPaginatedResult } from './dto/pagination.dto';

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly catalogRepo: CatalogRepository,
    private readonly libraryTx: LibraryTransactionService,
  ) {}

  private mapFlattenedState(item: any, userId?: string) {
    if (!item) return null;
    const userState = Array.isArray(item.userStates)
      ? item.userStates[0]
      : undefined;
    const { userStates, ...rest } = item;
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
    const item = await this.catalogRepo.findById(workspaceId, id);
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
    const limit = Math.min(options.limit ?? 50, 100);
    const [totalCount, rawItems] = await Promise.all([
      this.catalogRepo.count(workspaceId, options),
      this.catalogRepo.findMany(workspaceId, {
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
    context?: {
      tx?: import('@prisma/client').Prisma.TransactionClient;
      helpers?: import('../sync/library-transaction.service').TransactionHelpers;
      source?: import('../sync/library-event-catalog').LibraryItemSource;
    },
  ): Promise<any> {
    if (context?.tx && context?.helpers) {
      const item = await this.catalogRepo.create(workspaceId, data, context.tx);

      await context.helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId: item.id,
        action: 'create',
        version: item.version,
        data: item,
      });

      const payload = buildItemCreatedOutboxPayload({
        itemId: item.id,
        workspaceId,
        title: item.title,
        source: context.source || 'manual',
        doi: item.doi,
      });

      await context.helpers.publishOutbox(
        workspaceId,
        item.id,
        LIBRARY_EVENT_TYPES.ITEM_CREATED,
        payload,
      );

      return item;
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const item = await this.catalogRepo.create(workspaceId, data, tx);

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId: item.id,
        action: 'create',
        version: item.version,
        data: item,
      });

      const payload = buildItemCreatedOutboxPayload({
        itemId: item.id,
        workspaceId,
        title: item.title,
        source: context?.source || 'manual',
        doi: item.doi,
      });

      await helpers.publishOutbox(
        workspaceId,
        item.id,
        LIBRARY_EVENT_TYPES.ITEM_CREATED,
        payload,
      );

      return item;
    });
  }

  async updateItem(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    data: UpdateCatalogItemData,
    context?: {
      tx: import('@prisma/client').Prisma.TransactionClient;
      helpers: import('../sync/library-transaction.service').TransactionHelpers;
    },
  ): Promise<any> {
    if (context) {
      const updated = await this.catalogRepo.update(
        workspaceId,
        id,
        expectedVersion,
        data,
        context.tx,
      );

      await context.helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId: id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await context.helpers.publishOutbox(
        workspaceId,
        id,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        updated,
      );

      return updated;
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      return this.updateItem(workspaceId, id, expectedVersion, data, {
        tx,
        helpers,
      });
    });
  }

  async deleteItem(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
    context?: {
      tx: import('@prisma/client').Prisma.TransactionClient;
      helpers: import('../sync/library-transaction.service').TransactionHelpers;
    },
  ): Promise<boolean> {
    if (context) {
      const deleted = await this.catalogRepo.softDelete(
        workspaceId,
        id,
        expectedVersion,
        context.tx,
      );

      if (deleted) {
        await context.helpers.recordTombstone(workspaceId, {
          entityType: 'CatalogItem',
          entityId: id,
        });

        await context.helpers.publishOutbox(
          workspaceId,
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
      return this.deleteItem(workspaceId, id, expectedVersion, { tx, helpers });
    });
  }

  async restoreItem(workspaceId: string, id: string, expectedVersion?: number) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const restored = await this.catalogRepo.restore(
        workspaceId,
        id,
        expectedVersion,
        tx,
      );

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId: id,
        action: 'update',
        version: restored.version,
        data: restored,
      });

      await helpers.publishOutbox(workspaceId, id, 'library.item.restored', {
        id,
        restoredAt: new Date(),
      });

      return restored;
    });
  }

  async purgeItem(workspaceId: string, id: string): Promise<boolean> {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const purged = await this.catalogRepo.purge(workspaceId, id, tx);

      await helpers.recordTombstone(workspaceId, {
        entityType: 'CatalogItem',
        entityId: id,
      });

      await helpers.publishOutbox(workspaceId, id, 'library.item.purged', {
        id,
        purgedAt: new Date(),
      });

      return purged;
    });
  }

  async getRelatedItems(workspaceId: string, itemId: string) {
    const item = await this.catalogRepo.findById(workspaceId, itemId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const relations = await this.catalogRepo.getRelations(itemId);
    return {
      relatedItems: relations,
      relatedPapers: relations,
      total: relations.length,
    };
  }

  async linkItems(
    workspaceId: string,
    sourceItemId: string,
    data: { targetItemId: string; relationType?: string; note?: string },
  ) {
    const sourceItem = await this.catalogRepo.findById(workspaceId, sourceItemId);
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    const targetItem = await this.catalogRepo.findById(workspaceId, data.targetItemId);
    if (!targetItem) {
      throw new NotFoundException(`Target item ${data.targetItemId} not found`);
    }

    const linkedAt = new Date().toISOString();
    const type = data.relationType || 'related';

    const relation = {
      id: `rel_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      targetItemId: data.targetItemId,
      targetPaperId: data.targetItemId,
      targetId: data.targetItemId,
      relationType: type,
      type,
      note: data.note,
      description: data.note,
      linkedAt,
      createdAt: linkedAt,
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
    const sourceItem = await this.catalogRepo.findById(workspaceId, sourceItemId);
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
}

