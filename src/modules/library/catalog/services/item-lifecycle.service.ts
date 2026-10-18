import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import type { ItemTransactionContext } from '@/modules/library/catalog/types/items.types';
import { TransactionService, TransactionHelpers } from '@/modules/library/core';
import { TagsService } from '@/modules/library/catalog/services/tags.service';
import { ItemCacheService } from './item-cache.service';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';

@Injectable()
export class ItemLifecycleService {
  private readonly logger = new Logger(ItemLifecycleService.name);

  constructor(
    private readonly command: CommandRepository,
    private readonly libraryTx: TransactionService,
    private readonly tagsService: TagsService,
    private readonly itemCache: ItemCacheService,
  ) {}

  async deleteItem(
    userId: string,
    id: string,
    expectedVersion?: number,
    context?: ItemTransactionContext,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ): Promise<boolean> {
    const executeDelete = async (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ): Promise<boolean> => {
      const deleted = await this.command.softDelete(
        userId,
        id,
        expectedVersion,
        tx,
        projectId,
      );

      if (deleted) {
        const eventScope = { userId, projectId: projectId || undefined };
        await helpers.recordTombstone(eventScope, {
          entityType: 'Item',
          entityId: id,
          deletedById: userId,
        });

        await helpers.publishOutbox(eventScope, id, 'library.item.deleted', {
          id,
          deletedAt: new Date(),
          projectId,
        });
      }

      return deleted;
    };

    if (context) {
      const deleted = await executeDelete(context.tx, context.helpers);
      if (deleted) {
        await this.itemCache.invalidateItemCache(id, userId, projectId, {
          skipScopeInvalidation,
        });
      }
      return deleted;
    }

    const result = await this.libraryTx.executeInTransaction(executeDelete);
    if (result) {
      await this.itemCache.invalidateItemCache(id, userId, projectId, {
        skipScopeInvalidation,
      });
    }
    if (!skipScopeInvalidation) {
      await this.tagsService.invalidateTagsCache(userId, projectId);
    }
    return result;
  }

  async restoreItem(
    userId: string,
    id: string,
    expectedVersion?: number,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ) {
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const restored = await this.command.restore(
          userId,
          id,
          expectedVersion,
          tx,
          projectId,
        );

        const effectiveProjectId = restored.projectId || projectId || undefined;
        const eventScope = { userId, projectId: effectiveProjectId };

        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: id,
          action: 'update',
          version: restored.version,
          data: restored,
        });

        await helpers.publishOutbox(eventScope, id, 'library.item.restored', {
          id,
          restoredAt: new Date(),
          projectId: effectiveProjectId,
        });

        return ItemsMapper.toDomain(restored);
      },
    );

    if (!skipScopeInvalidation) {
      await this.tagsService.invalidateTagsCache(userId, projectId);
    }
    await this.itemCache.invalidateItemCache(id, userId, projectId, {
      skipScopeInvalidation,
    });
    return result;
  }

  async purgeItem(
    userId: string,
    id: string,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ): Promise<boolean> {
    const eventScope = { userId, projectId };
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const purged = await this.command.purge(userId, id, tx, projectId);

        await helpers.recordTombstone(eventScope, {
          entityType: 'Item',
          entityId: id,
        });

        await helpers.publishOutbox(eventScope, id, 'library.item.purged', {
          id,
          purgedAt: new Date(),
        });

        return purged;
      },
    );

    if (!skipScopeInvalidation) {
      await this.tagsService.invalidateTagsCache(userId, projectId);
    }
    await this.itemCache.invalidateItemCache(id, userId, projectId, {
      skipScopeInvalidation,
    });
    return result;
  }
}
