import {
  Injectable,
  Optional,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, TagType } from '@prisma/client';
import { TagsRepository } from '@/modules/library/catalog/repositories/tags.repository';
import { TransactionService } from '@/modules/library/core';
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

@Injectable()
export class TagsService {
  constructor(
    private readonly repo: TagsRepository,
    private readonly libraryTx: TransactionService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  async invalidateTagsCache(
    userId: UserId | string,
    projectId?: ProjectId | string,
    itemId?: ItemId | string,
  ): Promise<void> {
    if (this.cache) {
      await this.cache.delPattern(LIBRARY_REDIS_KEYS.tagsPattern(userId));
      await this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId));
      if (itemId) {
        await this.cache.del(LIBRARY_REDIS_KEYS.item(itemId));
        await this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(itemId));
        await this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(itemId));
      }
      if (projectId && projectId !== 'user') {
        await this.cache.delPattern(
          LIBRARY_REDIS_KEYS.tagsPattern(`proj:${projectId}`),
        );
        await this.cache.delPattern(
          LIBRARY_REDIS_KEYS.itemsPattern(`proj:${projectId}`),
        );
      }
    }
  }

  async getTags(
    userId: UserId | string,
    options?: { includeInactive?: boolean; projectId?: ProjectId | string },
  ) {
    if (this.cache) {
      const scopeKey =
        options?.projectId && options.projectId !== 'user'
          ? `proj:${options.projectId}`
          : userId;
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
  ) {
    const cleanName = cleanSingleTag(name);
    if (!cleanName) {
      throw new BadRequestException(
        `Invalid or disallowed tag name: "${name}"`,
      );
    }
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const tag = await this.repo.create(
          userId,
          cleanName,
          color,
          type,
          projectId,
          tx,
        );

        const effectiveProjectId =
          projectId &&
          projectId !== 'user' &&
          projectId !== 'me' &&
          projectId !== 'personal'
            ? projectId
            : undefined;
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
          'library.tag.created',
          tag,
        );

        return tag;
      },
    );

    await this.invalidateTagsCache(userId, projectId ?? undefined);
    return result;
  }

  async updateTag(
    userId: UserId | string,
    tagId: TagId | string,
    data: { name?: string; color?: string; type?: TagType },
    projectId?: ProjectId | string,
  ) {
    if (data.name) {
      const cleanName = cleanSingleTag(data.name);
      if (!cleanName) {
        throw new BadRequestException(
          `Invalid or disallowed tag name: "${data.name}"`,
        );
      }
      data.name = cleanName;
    }

    const effectiveProjectId =
      projectId &&
      projectId !== 'user' &&
      projectId !== 'me' &&
      projectId !== 'personal'
        ? projectId
        : undefined;
    const eventScope = { userId, projectId: effectiveProjectId };

    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
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

        await helpers.appendChange(eventScope, {
          entityType: 'Tag',
          entityId: tagId,
          action: 'update',
          version: 1,
          data: updated,
        });

        await helpers.publishOutbox(
          eventScope,
          tagId,
          'library.tag.updated',
          updated,
        );

        return updated;
      },
    );

    await this.invalidateTagsCache(userId, effectiveProjectId);
    return result;
  }

  async deleteTag(
    userId: UserId | string,
    tagId: TagId | string,
    projectId?: ProjectId | string,
  ) {
    const effectiveProjectId =
      projectId &&
      projectId !== 'user' &&
      projectId !== 'me' &&
      projectId !== 'personal'
        ? projectId
        : undefined;
    const eventScope = { userId, projectId: effectiveProjectId };

    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
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
            'library.tag.deleted',
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

    await this.invalidateTagsCache(userId, effectiveProjectId);
    return result;
  }

  async deleteAutomaticTags(
    userId: UserId | string,
    projectId?: ProjectId | string,
  ) {
    const effectiveProjectId =
      projectId &&
      projectId !== 'user' &&
      projectId !== 'me' &&
      projectId !== 'personal'
        ? projectId
        : undefined;
    const eventScope = { userId, projectId: effectiveProjectId };

    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const deletedTagIds = await this.repo.deleteAutomatic(
          userId,
          tx,
          effectiveProjectId,
        );
        for (const tagId of deletedTagIds) {
          await helpers.recordTombstone(eventScope, {
            entityType: 'Tag',
            entityId: tagId,
          });
          await helpers.publishOutbox(
            eventScope,
            tagId,
            'library.tag.deleted',
            {
              id: tagId,
              deletedAt: new Date(),
              projectId: effectiveProjectId,
            },
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
    const effectiveProjectId =
      projectId &&
      projectId !== 'user' &&
      projectId !== 'me' &&
      projectId !== 'personal'
        ? projectId
        : undefined;

    await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const tagWhere: Prisma.TagWhereInput = effectiveProjectId
        ? { id: tagId, projectId: effectiveProjectId }
        : { id: tagId, userId, projectId: null };
      const tag = await tx.tag.findFirst({
        where: tagWhere,
        select: { id: true },
      });
      if (!tag) {
        throw new NotFoundException(`Tag ${tagId} not found in library`);
      }

      const itemWhere: Prisma.ItemWhereInput = effectiveProjectId
        ? { id: itemId, projectId: effectiveProjectId, deletedAt: null }
        : { id: itemId, userId, projectId: null, deletedAt: null };
      const item = await tx.item.findFirst({
        where: itemWhere,
        select: { id: true },
      });
      if (!item) {
        throw new NotFoundException(`Item ${itemId} not found in library`);
      }

      await this.repo.assignToItem(tagId, itemId, tx);

      const eventScope = { userId, projectId: effectiveProjectId };

      await helpers.appendChange(eventScope, {
        entityType: 'ItemTag',
        entityId: `${tagId}:${itemId}`,
        action: 'create',
        version: 1,
        data: { tagId, itemId },
      });

      await helpers.publishOutbox(eventScope, itemId, 'library.item.tagged', {
        tagId,
        itemId,
        projectId: effectiveProjectId,
      });
    });

    await this.invalidateTagsCache(userId, effectiveProjectId, itemId);
  }

  async assignTagToItem(
    userId: UserId | string,
    itemId: ItemId | string,
    tagId: TagId | string,
    _type?: TagType,
    projectId?: ProjectId | string,
  ) {
    return this.assignTag(userId, tagId, itemId, projectId);
  }

  async removeTag(
    userId: UserId | string,
    tagId: TagId | string,
    itemId: ItemId | string,
    projectId?: ProjectId | string,
  ) {
    const effectiveProjectId =
      projectId &&
      projectId !== 'user' &&
      projectId !== 'me' &&
      projectId !== 'personal'
        ? projectId
        : undefined;

    await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const tagWhere: Prisma.TagWhereInput = effectiveProjectId
        ? { id: tagId, projectId: effectiveProjectId }
        : { id: tagId, userId, projectId: null };
      const tag = await tx.tag.findFirst({
        where: tagWhere,
        select: { id: true },
      });
      if (!tag) {
        throw new NotFoundException(`Tag ${tagId} not found in library`);
      }

      const itemWhere: Prisma.ItemWhereInput = effectiveProjectId
        ? { id: itemId, projectId: effectiveProjectId, deletedAt: null }
        : { id: itemId, userId, projectId: null, deletedAt: null };
      const item = await tx.item.findFirst({
        where: itemWhere,
        select: { id: true },
      });
      if (!item) {
        throw new NotFoundException(`Item ${itemId} not found in library`);
      }

      await this.repo.removeFromItem(tagId, itemId, tx);

      const eventScope = { userId, projectId: effectiveProjectId };

      await helpers.recordTombstone(eventScope, {
        entityType: 'ItemTag',
        entityId: `${tagId}:${itemId}`,
      });

      await helpers.publishOutbox(eventScope, itemId, 'library.item.untagged', {
        tagId,
        itemId,
        projectId: effectiveProjectId,
      });
    });

    await this.invalidateTagsCache(userId, effectiveProjectId, itemId);
  }

  async detachTagFromItem(
    userId: UserId | string,
    itemId: ItemId | string,
    tagId: TagId | string,
    projectId?: ProjectId | string,
  ) {
    return this.removeTag(userId, tagId, itemId, projectId);
  }

  async syncTagsToItem(
    tx: Prisma.TransactionClient,
    userId: UserId | string,
    itemId: ItemId | string,
    tagNames: string[],
    defaultTagType: TagType = TagType.automatic,
  ): Promise<void> {
    if (tagNames.length === 0) return;

    const resolvedTags = await resolveOrCreateTags(
      tx,
      userId,
      tagNames,
      defaultTagType,
    );
    if (resolvedTags.length === 0) return;

    await tx.itemTag.createMany({
      data: resolvedTags.map((tag) => ({
        tagId: tag.id,
        itemId,
        type: tag.type,
      })),
      skipDuplicates: true,
    });

    await this.invalidateTagsCache(userId);
  }

  async mergeTagsToItem(
    tx: Prisma.TransactionClient,
    sourceItemIds: (ItemId | string)[],
    targetItemId: ItemId | string,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;

    const primaryTags = await tx.itemTag.findMany({
      where: { itemId: targetItemId },
      select: { tagId: true },
    });
    const primaryTagIds = new Set(primaryTags.map((it) => it.tagId));

    const dupTags = await tx.itemTag.findMany({
      where: { itemId: { in: sourceItemIds } },
      select: { tagId: true },
    });

    const newTagIds = Array.from(
      new Set(
        dupTags
          .map((dup) => dup.tagId)
          .filter((tagId) => !primaryTagIds.has(tagId)),
      ),
    );

    if (newTagIds.length > 0) {
      if (typeof tx.itemTag.createMany === 'function') {
        await tx.itemTag.createMany({
          data: newTagIds.map((tagId) => ({
            itemId: targetItemId,
            tagId,
          })),
          skipDuplicates: true,
        });
      } else {
        for (const tagId of newTagIds) {
          await tx.itemTag.upsert({
            where: {
              tagId_itemId: {
                tagId,
                itemId: targetItemId,
              },
            },
            create: {
              itemId: targetItemId,
              tagId,
            },
            update: {},
          });
        }
      }
    }

    await tx.itemTag.deleteMany({
      where: { itemId: { in: sourceItemIds } },
    });
  }
}
