import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { RedisCacheService } from '@/core';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { ItemDetail } from '@/modules/library/core/types/bibliographic.types';
import {
  LIBRARY_EVENT_TYPES,
  LIBRARY_REDIS_KEYS,
  TransactionHelpers,
  normalizeProjectScopeId,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { ItemCacheCoordinator } from './item-cache.coordinator';

@Injectable()
export class ItemRelationsService {
  private readonly logger = new Logger(ItemRelationsService.name);

  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly libraryTx?: TransactionService,
    @Optional() private readonly cacheCoordinator?: ItemCacheCoordinator,
  ) {}

  private async invalidateRelationCaches(
    itemIds: string[],
    userId?: string,
    projectId?: string,
  ): Promise<void> {
    if (itemIds.length === 0) return;
    if (this.cacheCoordinator && userId) {
      await this.cacheCoordinator.invalidateBulkItemsCache(
        itemIds,
        userId,
        projectId,
      );
      return;
    }
    if (!this.cache) return;
    const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
    try {
      const validProjectId = normalizeProjectScopeId(projectId);
      const tasks: Promise<unknown>[] = uniqueIds.flatMap((id) => [
        this.cache!.del(LIBRARY_REDIS_KEYS.item(id)),
        this.cache!.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
        this.cache!.delPattern(LIBRARY_REDIS_KEYS.itemPattern(id)),
      ]);
      if (userId) {
        tasks.push(
          this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
        );
      }
      if (validProjectId) {
        tasks.push(
          this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(validProjectId)),
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.itemsPattern(`proj:${validProjectId}`),
          ),
        );
      }
      await Promise.all(tasks);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate relation caches: ${msg}`);
    }
  }

  async getRelatedItems(userId: string, itemId: string, projectId?: string) {
    const item = await this.query.findById(userId, itemId, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const relations = await this.query.getRelations(itemId);
    return {
      relatedItems: relations,
      total: relations.length,
    };
  }

  async addRelation(
    userId: string,
    sourceItemId: string,
    data: {
      targetItemId?: string;
      targetItemIds?: string[];
      relationType?: string;
      note?: string;
    },
    projectId?: string,
  ) {
    return this.linkItems(userId, sourceItemId, data, projectId);
  }

  async removeRelation(
    userId: string,
    sourceItemId: string,
    targetItemId: string,
    projectId?: string,
  ) {
    return this.unlinkItems(userId, sourceItemId, targetItemId, projectId);
  }

  async linkItems(
    userId: string,
    sourceItemId: string,
    data: {
      targetItemId?: string;
      targetItemIds?: string[];
      relationType?: string;
      note?: string;
    },
    projectId?: string,
  ) {
    const sourceItem = await this.query.findById(
      userId,
      sourceItemId,
      projectId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    const rawIds = [
      ...(Array.isArray(data.targetItemIds) ? data.targetItemIds : []),
      ...(data.targetItemId ? [data.targetItemId] : []),
    ];
    const targetIds = Array.from(
      new Set(rawIds.filter((id) => id && id !== sourceItemId)),
    );

    if (targetIds.length === 0) {
      throw new BadRequestException(
        'At least one valid target item ID (different from source) must be provided',
      );
    }

    const type = data.relationType ?? 'related';
    const now = new Date().toISOString();
    const linkedRelations: Array<{
      id: string;
      targetItemId: string;
      relationType: string;
      description: string | undefined;
      note: string | undefined;
      linkedAt: string;
      targetTitle: string;
    }> = [];

    // Batch fetch target items to eliminate N+1 queries
    let targetItemMap = new Map<string, ItemDetail>();
    if (this.query.findByIds && targetIds.length > 0) {
      const targetItems = await this.query.findByIds(
        userId,
        targetIds,
        projectId,
      );
      if (targetItems && targetItems.length > 0) {
        targetItemMap = new Map(targetItems.map((item) => [item.id, item]));
      }
    }

    const resolvedTargets: Array<{
      targetItem: ItemDetail;
      relation: {
        id: string;
        targetItemId: string;
        relationType: string;
        description: string | undefined;
        note: string | undefined;
        linkedAt: string;
      };
    }> = [];

    for (const targetId of targetIds) {
      const targetItem =
        targetItemMap.get(targetId) ||
        (await this.query.findById(userId, targetId, projectId));
      if (!targetItem) continue;

      const relation = {
        id: randomUUID(),
        targetItemId: targetId,
        relationType: type,
        description: data.note,
        note: data.note,
        linkedAt: now,
      };
      resolvedTargets.push({ targetItem, relation });
    }

    const effectiveProjectId =
      normalizeProjectScopeId(projectId ?? sourceItem.projectId) ?? undefined;
    const eventScope = { userId, projectId: effectiveProjectId };

    if (this.libraryTx && resolvedTargets.length > 0) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          await Promise.all(
            resolvedTargets.map(async ({ targetItem, relation }) => {
              await this.command.putRelation(sourceItemId, relation, tx);
              linkedRelations.push({
                ...relation,
                targetTitle: targetItem.title,
              });
            }),
          );
          await helpers.appendChange(eventScope, {
            entityType: 'Item',
            entityId: sourceItemId,
            action: 'update',
            version: sourceItem.version ?? 1,
            data: { id: sourceItemId, relations: linkedRelations },
          });
          await helpers.publishOutbox(
            eventScope,
            sourceItemId,
            LIBRARY_EVENT_TYPES.ITEM_UPDATED,
            {
              itemId: sourceItemId,
              relatedItemIds: resolvedTargets.map((r) => r.targetItem.id),
              userId,
              projectId: effectiveProjectId,
            },
          );
        },
      );
    } else {
      await Promise.all(
        resolvedTargets.map(async ({ targetItem, relation }) => {
          await this.command.putRelation(sourceItemId, relation);
          linkedRelations.push({
            ...relation,
            targetTitle: targetItem.title,
          });
        }),
      );
    }

    await this.invalidateRelationCaches(
      [sourceItemId, ...linkedRelations.map((r) => r.targetItemId)],
      userId,
      effectiveProjectId,
    );

    return {
      success: true,
      link: linkedRelations[0] || null,
      links: linkedRelations,
      totalLinked: linkedRelations.length,
      message:
        linkedRelations.length === 1
          ? `Linked "${sourceItem.title}" to "${linkedRelations[0].targetTitle}"`
          : `Linked ${linkedRelations.length} item(s) to "${sourceItem.title}"`,
    };
  }

  async unlinkItems(
    userId: string,
    sourceItemId: string,
    targetItemId: string,
    projectId?: string,
  ) {
    const sourceItem = await this.query.findById(
      userId,
      sourceItemId,
      projectId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    const effectiveProjectId =
      normalizeProjectScopeId(projectId ?? sourceItem.projectId) ?? undefined;
    const eventScope = { userId, projectId: effectiveProjectId };

    if (this.libraryTx) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          await this.command.removeRelation(sourceItemId, targetItemId, tx);
          await helpers.appendChange(eventScope, {
            entityType: 'Item',
            entityId: sourceItemId,
            action: 'update',
            version: sourceItem.version ?? 1,
            data: { id: sourceItemId, unlinkedTargetItemId: targetItemId },
          });
          await helpers.publishOutbox(
            eventScope,
            sourceItemId,
            LIBRARY_EVENT_TYPES.ITEM_UPDATED,
            {
              itemId: sourceItemId,
              relatedItemId: targetItemId,
              userId,
              projectId: effectiveProjectId,
            },
          );
        },
      );
    } else {
      await this.command.removeRelation(sourceItemId, targetItemId);
    }

    await this.invalidateRelationCaches(
      [sourceItemId, targetItemId],
      userId,
      effectiveProjectId,
    );

    return {
      success: true,
      unlinked: true,
      message: `Removed relation between "${sourceItem.title}" and "${targetItemId}"`,
    };
  }
}
