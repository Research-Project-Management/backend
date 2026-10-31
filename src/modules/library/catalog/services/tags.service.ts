import {
  Injectable,
  Optional,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, TagType } from '@prisma/client';
import { TagsRepository } from '@/modules/library/catalog/repositories/tags.repository';
import {
  normalizeProjectScopeId,
  LIBRARY_EVENT_TYPES,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { cleanSingleTag } from '@/modules/library/core/domain/tag.domain';
import { resolveOrCreateTags } from '@/modules/library/catalog/domain/command-payload.builder';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import {
  UserId,
  TagId,
  ItemId,
  ProjectId,
} from '@/modules/library/core/types/branded.types';
import { ItemCacheCoordinator } from './item-cache.coordinator';

@Injectable()
export class TagsService {
  constructor(
    private readonly repo: TagsRepository,
    private readonly libraryTx: TransactionService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly cacheCoordinator?: ItemCacheCoordinator,
  ) {}

  async invalidateTagsCache(
    userId: UserId | string,
    projectId?: ProjectId | string,
    itemId?: ItemId | string | (ItemId | string)[],
  ): Promise<void> {
    const itemIds = Array.isArray(itemId)
      ? itemId.filter(Boolean).map(String)
      : itemId
        ? [String(itemId)]
        : [];
    if (this.cacheCoordinator) {
      await this.cacheCoordinator.invalidateForWrite({
        userId: String(userId),
        projectId: projectId ? String(projectId) : undefined,
        itemIds: itemIds.length > 0 ? itemIds : undefined,
      });
      return;
    }
    if (this.cache) {
      await Promise.all([
        this.cache.delPattern(LIBRARY_REDIS_KEYS.tagsPattern(userId)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.countsPattern(userId)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.searchFacetsPattern(userId)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.searchItemsPattern(userId)),
        this.cache.del(LIBRARY_REDIS_KEYS.searchVersion(userId)),
      ]);
      if (itemIds.length > 0) {
        await Promise.all(
          itemIds.flatMap((id) => [
            this.cache!.del(LIBRARY_REDIS_KEYS.item(id)),
            this.cache!.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
            this.cache!.delPattern(LIBRARY_REDIS_KEYS.itemPattern(id)),
          ]),
        );
      }
      const validProjectId = normalizeProjectScopeId(projectId);
      if (validProjectId) {
        await Promise.all([
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.tagsPattern(`proj:${validProjectId}`),
          ),
          this.cache.delPattern(LIBRARY_REDIS_KEYS.tagsPattern(validProjectId)),
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.itemsPattern(`proj:${validProjectId}`),
          ),
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.itemsPattern(validProjectId),
          ),
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.countsPattern(validProjectId),
          ),
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.countsPattern(`proj:${validProjectId}`),
          ),
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.searchFacetsPattern(validProjectId),
          ),
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.searchItemsPattern(validProjectId),
          ),
          this.cache.del(LIBRARY_REDIS_KEYS.searchVersion(validProjectId)),
          this.cache.del(
            LIBRARY_REDIS_KEYS.searchVersion(`proj:${validProjectId}`),
          ),
        ]);
      }
    }
  }

  async getTags(
    userId: UserId | string,
    options?: { includeInactive?: boolean; projectId?: ProjectId | string },
  ) {
    if (this.cache) {
      const validProjectId = normalizeProjectScopeId(options?.projectId);
      const scopeKey = validProjectId ? `proj:${validProjectId}` : userId;
      const cacheKey = options?.includeInactive
        ? `${LIBRARY_REDIS_KEYS.tags(scopeKey)}:all`
        : LIBRARY_REDIS_KEYS.tags(scopeKey);
      return this.cache.wrap(
        cacheKey,
        () => this.repo.findMany(userId, options),
        300,
      );
    }
    return this.repo.findMany(userId, options);
  }

  async createOrGetTag(
    userId: UserId | string,
    name: string,
    color?: string,
    type?: TagType,
    projectId?: ProjectId | string | null,
    shortcut?: number | null,
  ) {
    const cleanName = cleanSingleTag(name);
    if (!cleanName) {
      throw new BadRequestException(
        `Invalid or disallowed tag name: "${name}"`,
      );
    }
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const tag = await this.repo.create(
          userId,
          cleanName,
          color,
          type,
          effectiveProjectId,
          tx,
          shortcut,
        );

        const eventScope = { userId, projectId: effectiveProjectId };

        await helpers.appendChange(eventScope, {
          entityType: 'Tag',
          entityId: tag.id,
          action: 'create',
          version: 1,
          data: tag,
        });

        await helpers.publishOutbox(
          eventScope,
          tag.id,
          LIBRARY_EVENT_TYPES.TAG_CREATED,
          tag,
        );

        return tag;
      },
    );

    await this.invalidateTagsCache(userId, effectiveProjectId);
    return result;
  }

  async updateTag(
    userId: UserId | string,
    tagId: TagId | string,
    data: {
      name?: string;
      color?: string;
      type?: TagType;
      shortcut?: number | null;
      expectedVersion?: number;
    },
    projectId?: ProjectId | string,
  ) {
    if (data.name !== undefined) {
      const cleanName = cleanSingleTag(data.name);
      if (!cleanName) {
        throw new BadRequestException(
          `Invalid or disallowed tag name: "${data.name}"`,
        );
      }
      data.name = cleanName;
    }

    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const eventScope = { userId, projectId: effectiveProjectId };

    let affectedItemIds: string[] = [];
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        if (this.repo?.findItemIdsByTagIds) {
          affectedItemIds = await this.repo.findItemIdsByTagIds(
            [String(tagId)],
            tx,
          );
        }
        const updated = await this.repo.update(
          userId,
          tagId,
          data,
          tx,
          effectiveProjectId,
        );
        if (!updated) {
          throw new NotFoundException(`Tag ${tagId} not found`);
        }

        const mergedFromTagId =
          (updated as { _mergedFromTagId?: string })._mergedFromTagId ||
          (updated.id !== tagId ? tagId : undefined);
        if (mergedFromTagId) {
          await helpers.recordTombstone(eventScope, {
            entityType: 'Tag',
            entityId: mergedFromTagId,
          });
          await helpers.appendChange(eventScope, {
            entityType: 'Tag',
            entityId: mergedFromTagId,
            action: 'delete',
            version: 0,
            data: null,
          });
        }

        await helpers.appendChange(eventScope, {
          entityType: 'Tag',
          entityId: updated.id,
          action: 'update',
          version: (updated as { version?: number }).version ?? 1,
          data: updated,
        });

        await helpers.publishOutbox(
          eventScope,
          updated.id,
          LIBRARY_EVENT_TYPES.TAG_UPDATED,
          updated,
        );

        return updated;
      },
    );

    await this.invalidateTagsCache(userId, effectiveProjectId, affectedItemIds);
    return result;
  }

  async deleteTag(
    userId: UserId | string,
    tagId: TagId | string,
    projectId?: ProjectId | string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const eventScope = { userId, projectId: effectiveProjectId };

    let affectedItemIds: string[] = [];
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        if (this.repo?.findItemIdsByTagIds) {
          affectedItemIds = await this.repo.findItemIdsByTagIds(
            [String(tagId)],
            tx,
          );
        }
        const deleted = await this.repo.delete(
          userId,
          tagId,
          tx,
          effectiveProjectId,
        );
        if (deleted) {
          await helpers.recordTombstone(eventScope, {
            entityType: 'Tag',
            entityId: tagId,
          });

          await helpers.publishOutbox(
            eventScope,
            tagId,
            LIBRARY_EVENT_TYPES.TAG_DELETED,
            {
              id: tagId,
              deletedAt: new Date(),
              projectId: effectiveProjectId,
            },
          );
        }
        return deleted;
      },
    );

    await this.invalidateTagsCache(userId, effectiveProjectId, affectedItemIds);
    return result;
  }

  async deleteAutomaticTags(
    userId: UserId | string,
    projectId?: ProjectId | string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const eventScope = { userId, projectId: effectiveProjectId };

    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const deletedTagIds = await this.repo.deleteAutomatic(
          userId,
          tx,
          effectiveProjectId,
        );
        if (deletedTagIds.length > 0) {
          const deletedAt = new Date();
          const deletedIso = deletedAt.toISOString();
          await helpers.recordTombstonesBatch(
            eventScope,
            deletedTagIds.map((tagId) => ({
              entityType: 'Tag',
              entityId: tagId,
            })),
          );
          if (helpers.appendChangesBatch) {
            await helpers.appendChangesBatch(
              eventScope,
              deletedTagIds.map((tagId) => ({
                entityType: 'Tag',
                entityId: tagId,
                action: 'delete',
                version: 0,
                data: { id: tagId, deletedAt: deletedIso },
              })),
            );
          }
          await helpers.publishOutboxBatch(
            eventScope,
            deletedTagIds.map((tagId) => ({
              aggregateId: tagId,
              eventType: LIBRARY_EVENT_TYPES.TAG_DELETED,
              payload: {
                id: tagId,
                deletedAt,
                projectId: effectiveProjectId,
              },
            })),
          );
        }
        return { count: deletedTagIds.length };
      },
    );

    await this.invalidateTagsCache(userId, effectiveProjectId);
    return result;
  }

  async assignTag(
    userId: UserId | string,
    tagId: TagId | string,
    itemId: ItemId | string,
    projectId?: ProjectId | string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(projectId);

    await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      if (this.repo?.assignTagToItem) {
        await this.repo.assignTagToItem(
          userId,
          tagId,
          itemId,
          effectiveProjectId,
          tx,
        );
      } else {
        const tagWhere: Prisma.TagWhereInput = effectiveProjectId
          ? { id: tagId, projectId: effectiveProjectId }
          : { id: tagId, userId, projectId: null };
        const itemWhere: Prisma.ItemWhereInput = effectiveProjectId
          ? { id: itemId, projectId: effectiveProjectId, deletedAt: null }
          : { id: itemId, userId, projectId: null, deletedAt: null };

        const [tag, item] = await Promise.all([
          tx.tag.findFirst({
            where: tagWhere,
            select: { id: true },
          }),
          tx.item.findFirst({
            where: itemWhere,
            select: { id: true },
          }),
        ]);
        if (!tag) {
          throw new NotFoundException(`Tag ${tagId} not found in library`);
        }
        if (!item) {
          throw new NotFoundException(`Item ${itemId} not found in library`);
        }

        await this.repo.assignToItem(tagId, itemId, tx);
      }

      const eventScope = { userId, projectId: effectiveProjectId };

      await helpers.appendChange(eventScope, {
        entityType: 'ItemTag',
        entityId: `${tagId}:${itemId}`,
        action: 'create',
        version: 1,
        data: { tagId, itemId },
      });

      await helpers.publishOutbox(
        eventScope,
        itemId,
        LIBRARY_EVENT_TYPES.ITEM_TAGGED,
        {
          tagId,
          itemId,
          projectId: effectiveProjectId,
        },
      );
    });

    await this.invalidateTagsCache(userId, effectiveProjectId, itemId);
  }

  async removeTag(
    userId: UserId | string,
    tagId: TagId | string,
    itemId: ItemId | string,
    projectId?: ProjectId | string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(projectId);

    await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      if (this.repo?.removeTagFromItem) {
        await this.repo.removeTagFromItem(
          userId,
          tagId,
          itemId,
          effectiveProjectId,
          tx,
        );
      } else {
        const tagWhere: Prisma.TagWhereInput = effectiveProjectId
          ? { id: tagId, projectId: effectiveProjectId }
          : { id: tagId, userId, projectId: null };
        const itemWhere: Prisma.ItemWhereInput = effectiveProjectId
          ? { id: itemId, projectId: effectiveProjectId, deletedAt: null }
          : { id: itemId, userId, projectId: null, deletedAt: null };

        const [tag, item] = await Promise.all([
          tx.tag.findFirst({
            where: tagWhere,
            select: { id: true },
          }),
          tx.item.findFirst({
            where: itemWhere,
            select: { id: true },
          }),
        ]);
        if (!tag) {
          throw new NotFoundException(`Tag ${tagId} not found in library`);
        }
        if (!item) {
          throw new NotFoundException(`Item ${itemId} not found in library`);
        }

        await this.repo.removeFromItem(tagId, itemId, tx);
      }

      const eventScope = { userId, projectId: effectiveProjectId };

      await helpers.recordTombstone(eventScope, {
        entityType: 'ItemTag',
        entityId: `${tagId}:${itemId}`,
      });

      await helpers.publishOutbox(
        eventScope,
        itemId,
        LIBRARY_EVENT_TYPES.ITEM_UNTAGGED,
        {
          tagId,
          itemId,
          projectId: effectiveProjectId,
        },
      );
    });

    await this.invalidateTagsCache(userId, effectiveProjectId, itemId);
  }

  async syncTagsToItem(
    tx: Prisma.TransactionClient,
    userId: UserId | string,
    itemId: ItemId | string,
    tagNames: string[],
    defaultTagType: TagType = TagType.automatic,
    projectId?: ProjectId | string,
  ): Promise<void> {
    if (tagNames.length === 0) return;

    const executeSync = async (client: Prisma.TransactionClient) => {
      if (this.repo?.syncItemTags) {
        return this.repo.syncItemTags(
          userId,
          itemId,
          tagNames,
          defaultTagType,
          normalizeProjectScopeId(projectId),
          client,
        );
      }
      const resolvedTags = await resolveOrCreateTags(
        client,
        userId,
        tagNames,
        defaultTagType,
        normalizeProjectScopeId(projectId),
      );
      if (resolvedTags.length === 0) return false;

      await client.itemTag.createMany({
        data: resolvedTags.map((tag) => ({
          tagId: tag.id,
          itemId,
          type: tag.type,
        })),
        skipDuplicates: true,
      });
      return true;
    };

    if (this.libraryTx && !tx) {
      const synced = await this.libraryTx.executeInTransaction((innerTx) =>
        executeSync(innerTx),
      );
      if (synced) {
        await this.invalidateTagsCache(userId, projectId, itemId);
      }
      return;
    }

    // When `tx` is passed from an outer transaction, cache invalidation is handled
    // by the outer caller after the transaction commits.
    await executeSync(tx);
  }

  async mergeTagsToItem(
    tx: Prisma.TransactionClient,
    sourceItemIds: (ItemId | string)[],
    targetItemId: ItemId | string,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;
    if (this.repo?.mergeTagsIntoTarget) {
      await this.repo.mergeTagsIntoTarget(sourceItemIds, targetItemId, tx);
      return;
    }

    const [primaryTags, dupTags] = await Promise.all([
      tx.itemTag.findMany({
        where: { itemId: targetItemId },
        select: { tagId: true },
      }),
      tx.itemTag.findMany({
        where: { itemId: { in: sourceItemIds } },
        select: { tagId: true },
      }),
    ]);
    const primaryTagIds = new Set(primaryTags.map((it) => it.tagId));

    const newTagIds = Array.from(
      new Set(
        dupTags
          .map((dup) => dup.tagId)
          .filter((tagId) => !primaryTagIds.has(tagId)),
      ),
    );

    if (newTagIds.length > 0) {
      await tx.itemTag.createMany({
        data: newTagIds.map((tagId) => ({
          itemId: targetItemId,
          tagId,
        })),
        skipDuplicates: true,
      });
    }

    await tx.itemTag.deleteMany({
      where: { itemId: { in: sourceItemIds } },
    });
  }
}
