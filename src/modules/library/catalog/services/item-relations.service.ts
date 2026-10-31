import {
  Injectable,
  Inject,
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
  TransactionHelpers,
  UNIT_OF_WORK,
  IUnitOfWork,
  normalizeProjectScopeId,
  executeStandardLibraryCacheInvalidation,
} from '@/modules/library/core';
import { ItemCacheCoordinator } from './item-cache.coordinator';

@Injectable()
export class ItemRelationsService {
  private readonly logger = new Logger(ItemRelationsService.name);

  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx?: IUnitOfWork,
    @Optional() private readonly cacheCoordinator?: ItemCacheCoordinator,
  ) {}

  private async invalidateRelationCaches(
    itemIds: string[],
    userId?: string,
    projectId?: string,
  ): Promise<void> {
    if (itemIds.length === 0) return;
    await executeStandardLibraryCacheInvalidation(
      this.cacheCoordinator,
      this.cache,
      { userId, projectId, itemIds },
      (msg) => this.logger.warn(`Failed to invalidate relation caches: ${msg}`),
    );
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

    // Batch fetch target items before opening transaction (zero N+1 fallback queries)
    const targetItemMap = new Map<string, ItemDetail>();
    const batchTargets = this.query.findByIds
      ? await this.query.findByIds(userId, targetIds, projectId)
      : undefined;
    if (Array.isArray(batchTargets)) {
      for (const item of batchTargets) {
        if (item) targetItemMap.set(item.id, item);
      }
    } else {
      const fallbackTargets = await Promise.all(
        targetIds.map((targetId) =>
          this.query.findById(userId, targetId, projectId),
        ),
      );
      for (const item of fallbackTargets) {
        if (item) targetItemMap.set(item.id, item);
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
      const targetItem = targetItemMap.get(targetId);
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

    if (resolvedTargets.length === 0) {
      throw new NotFoundException(
        `Target item(s) ${targetIds.join(', ')} not found`,
      );
    }

    const effectiveProjectId =
      normalizeProjectScopeId(projectId ?? sourceItem.projectId) ?? undefined;
    const eventScope = { userId, projectId: effectiveProjectId };

    let ranPostCommitHook = false;
    if (this.libraryTx) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          ranPostCommitHook = Boolean(helpers?.onAfterCommit);
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
          helpers?.onAfterCommit?.(() =>
            this.invalidateRelationCaches(
              [sourceItemId, ...linkedRelations.map((r) => r.targetItemId)],
              userId,
              effectiveProjectId,
            ),
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

    if (!ranPostCommitHook) {
      await this.invalidateRelationCaches(
        [sourceItemId, ...linkedRelations.map((r) => r.targetItemId)],
        userId,
        effectiveProjectId,
      );
    }

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

    let ranPostCommitHook = false;
    if (this.libraryTx) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          ranPostCommitHook = Boolean(helpers?.onAfterCommit);
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
          helpers?.onAfterCommit?.(() =>
            this.invalidateRelationCaches(
              [sourceItemId, targetItemId],
              userId,
              effectiveProjectId,
            ),
          );
        },
      );
    } else {
      await this.command.removeRelation(sourceItemId, targetItemId);
    }

    if (!ranPostCommitHook) {
      await this.invalidateRelationCaches(
        [sourceItemId, targetItemId],
        userId,
        effectiveProjectId,
      );
    }

    return {
      success: true,
      unlinked: true,
      message: `Removed relation between "${sourceItem.title}" and "${targetItemId}"`,
    };
  }
}
