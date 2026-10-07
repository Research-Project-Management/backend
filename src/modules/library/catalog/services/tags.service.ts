import {
  Injectable,
  Optional,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, TagType } from '@prisma/client';
import { TagsRepository } from '../repositories/tags.repository';
import { TransactionService } from '../../sync';
import {
  normalizeTags,
  cleanSingleTag,
} from '../../shared-kernel/utils/tag.utils';
import { RedisCacheService } from '../../../../core/cache/redis.service';
import { LIBRARY_REDIS_KEYS } from '../../shared-kernel/core/constants/redis-keys.constants';
import {
  UserId,
  TagId,
  ItemId,
  ProjectId,
} from '../../shared-kernel/core/types/branded.types';

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
  ): Promise<void> {
    if (this.cache) {
      await this.cache.delPattern(LIBRARY_REDIS_KEYS.tagsPattern(userId));
      if (projectId && projectId !== 'user') {
        await this.cache.delPattern(
          LIBRARY_REDIS_KEYS.tagsPattern(`proj:${projectId}`),
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
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const tagWhere: any =
        projectId && projectId !== 'user'
          ? { id: tagId, OR: [{ userId }, { projectId }] }
          : { id: tagId, userId };
      const tag = await tx.tag.findFirst({
        where: tagWhere,
        select: { id: true },
      });
      if (!tag) {
        throw new NotFoundException(`Tag ${tagId} not found in library`);
      }

      const itemWhere: any =
        projectId && projectId !== 'user'
          ? { id: itemId, OR: [{ userId }, { projectId }], deletedAt: null }
          : { id: itemId, userId, deletedAt: null };
      const item = await tx.item.findFirst({
        where: itemWhere,
        select: { id: true },
      });
      if (!item) {
        throw new NotFoundException(`Item ${itemId} not found in library`);
      }

      await this.repo.assignToItem(tagId, itemId, tx);

      const effectiveProjectId =
        projectId &&
        projectId !== 'user' &&
        projectId !== 'me' &&
        projectId !== 'personal'
          ? projectId
          : undefined;
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
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const tagWhere: any =
        projectId && projectId !== 'user'
          ? { id: tagId, OR: [{ userId }, { projectId }] }
          : { id: tagId, userId };
      const tag = await tx.tag.findFirst({
        where: tagWhere,
        select: { id: true },
      });
      if (!tag) {
        throw new NotFoundException(`Tag ${tagId} not found in library`);
      }

      const itemWhere: any =
        projectId && projectId !== 'user'
          ? { id: itemId, OR: [{ userId }, { projectId }], deletedAt: null }
          : { id: itemId, userId, deletedAt: null };
      const item = await tx.item.findFirst({
        where: itemWhere,
        select: { id: true },
      });
      if (!item) {
        throw new NotFoundException(`Item ${itemId} not found in library`);
      }

      await this.repo.removeFromItem(tagId, itemId, tx);

      const effectiveProjectId =
        projectId &&
        projectId !== 'user' &&
        projectId !== 'me' &&
        projectId !== 'personal'
          ? projectId
          : undefined;
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

    const dedupedTags = normalizeTags(tagNames);
    if (dedupedTags.length === 0) return;

    const existingTags = await tx.tag.findMany({
      where: {
        userId,
        name: { in: dedupedTags, mode: 'insensitive' },
      },
      select: { id: true, name: true },
    });

    const existingNameSet = new Set(
      existingTags.map((t) => t.name.toLowerCase()),
    );

    const missingNames = dedupedTags.filter(
      (n) => !existingNameSet.has(n.toLowerCase()),
    );
    if (missingNames.length > 0) {
      await tx.tag.createMany({
        data: missingNames.map((name) => ({
          userId,
          name,
          type: defaultTagType,
        })),
        skipDuplicates: true,
      });
    }

    const allTags =
      missingNames.length > 0
        ? await tx.tag.findMany({
            where: {
              userId,
              name: { in: dedupedTags, mode: 'insensitive' },
            },
            select: { id: true },
          })
        : existingTags;

    await tx.itemTag.createMany({
      data: allTags.map((tag) => ({ tagId: tag.id, itemId })),
      skipDuplicates: true,
    });

    if (missingNames.length > 0) {
      await this.invalidateTagsCache(userId);
    }
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

    for (const dup of dupTags) {
      if (!primaryTagIds.has(dup.tagId)) {
        await tx.itemTag.upsert({
          where: {
            tagId_itemId: {
              tagId: dup.tagId,
              itemId: targetItemId,
            },
          },
          create: {
            itemId: targetItemId,
            tagId: dup.tagId,
          },
          update: {},
        });
        primaryTagIds.add(dup.tagId);
      }
    }

    await tx.itemTag.deleteMany({
      where: { itemId: { in: sourceItemIds } },
    });
  }
}
