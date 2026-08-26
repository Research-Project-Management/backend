import { Injectable, Logger } from '@nestjs/common';
import {
  CatalogRepository,
  CreateCatalogItemData,
  UpdateCatalogItemData,
} from './catalog.repository';
import { LibraryTransactionService } from '../sync-core/library-transaction.service';
import { CursorPaginatedResult } from '../common/library-contracts';

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly catalogRepo: CatalogRepository,
    private readonly libraryTx: LibraryTransactionService,
  ) {}

  async getItem(workspaceId: string, id: string) {
    return this.catalogRepo.findById(workspaceId, id);
  }

  async listItems(
    workspaceId: string,
    options: {
      collectionId?: string;
      tagId?: string;
      search?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<CursorPaginatedResult<any>> {
    const limit = Math.min(options.limit ?? 50, 100);
    const items = await this.catalogRepo.findMany(workspaceId, {
      ...options,
      limit,
    });

    let hasNextPage = false;
    let nextCursor: string | undefined;

    if (items.length > limit) {
      hasNextPage = true;
      const popped = items.pop();
      nextCursor = popped?.id;
    }

    return {
      items,
      meta: {
        cursor: nextCursor,
        hasNextPage,
        totalCount: items.length,
      },
    };
  }

  async createItem(workspaceId: string, data: CreateCatalogItemData) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const item = await this.catalogRepo.create(workspaceId, data, tx);

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId: item.id,
        action: 'create',
        version: item.version,
        data: item,
      });

      await helpers.publishOutbox(
        workspaceId,
        item.id,
        'library.item.created',
        item,
      );

      return item;
    });
  }

  async updateItem(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    data: UpdateCatalogItemData,
  ) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const updated = await this.catalogRepo.update(
        workspaceId,
        id,
        expectedVersion,
        data,
        tx,
      );

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await helpers.publishOutbox(
        workspaceId,
        updated.id,
        'library.item.updated',
        updated,
      );

      return updated;
    });
  }

  async deleteItem(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<boolean> {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const deleted = await this.catalogRepo.softDelete(
        workspaceId,
        id,
        expectedVersion,
        tx,
      );

      if (deleted) {
        await helpers.recordTombstone(workspaceId, {
          entityType: 'CatalogItem',
          entityId: id,
        });

        await helpers.publishOutbox(workspaceId, id, 'library.item.deleted', {
          id,
          deletedAt: new Date(),
        });
      }

      return deleted;
    });
  }
}
