import { Injectable, Optional, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TagsRepository } from './tags.repository';
import { TransactionService } from '../outbox/transaction.service';
import { normalizeTags, cleanSingleTag } from './utils/tags.utils';
import { RedisCacheService } from '../../../core/cache/redis.service';
import { LIBRARY_REDIS_KEYS } from '../core/constants/redis-keys.constant';
import { PrismaService } from '../../../core/database/prisma.service';

@Injectable()
export class TagsService {
  constructor(
    private readonly repo: TagsRepository,
    private readonly libraryTx: TransactionService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  async invalidateTagsCache(userId: string, projectId?: string): Promise<void> {
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
    userId: string,
    options?: { includeInactive?: boolean; projectId?: string },
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
    userId: string,
    name: string,
    color?: string,
    type?: string,
    projectId?: string | null,
  ) {
    const cleanName = cleanSingleTag(name) || name.trim();
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

        await helpers.appendChange(userId, {
          entityType: 'Tag',
          entityId: tag.id,
          action: 'create',
          version: 1,
          data: tag,
        });

        await helpers.publishOutbox(userId, tag.id, 'library.tag.created', tag);

        return tag;
      },
    );

    await this.invalidateTagsCache(userId, projectId ?? undefined);
    return result;
  }

  async deleteTag(userId: string, tagId: string) {
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const deleted = await this.repo.delete(userId, tagId, tx);
        if (deleted) {
          await helpers.recordTombstone(userId, {
            entityType: 'Tag',
            entityId: tagId,
          });

          await helpers.publishOutbox(userId, tagId, 'library.tag.deleted', {
            id: tagId,
            deletedAt: new Date(),
          });
        }
        return deleted;
      },
    );

    await this.invalidateTagsCache(userId);
    return result;
  }

  async deleteAutomaticTags(userId: string) {
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const deletedTagIds = await this.repo.deleteAutomatic(userId, tx);
        for (const tagId of deletedTagIds) {
          await helpers.recordTombstone(userId, {
            entityType: 'Tag',
            entityId: tagId,
          });
          await helpers.publishOutbox(userId, tagId, 'library.tag.deleted', {
            id: tagId,
            deletedAt: new Date(),
          });
        }
        return { count: deletedTagIds.length };
      },
    );

    await this.invalidateTagsCache(userId);
    return result;
  }

  async assignTag(userId: string, tagId: string, itemId: string, projectId?: string) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      // 1. Verify tag belongs to user/project scope
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

      // 2. Verify item belongs to user/project scope
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

      await helpers.appendChange(userId, {
        entityType: 'ItemTag',
        entityId: `${tagId}:${itemId}`,
        action: 'create',
        version: 1,
        data: { tagId, itemId },
      });

      await helpers.publishOutbox(userId, itemId, 'library.item.tagged', {
        tagId,
        itemId,
      });
    });
  }

  async removeTag(userId: string, tagId: string, itemId: string, projectId?: string) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      // 1. Verify tag belongs to user/project scope
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

      // 2. Verify item belongs to user/project scope
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

      await helpers.recordTombstone(userId, {
        entityType: 'ItemTag',
        entityId: `${tagId}:${itemId}`,
      });

      await helpers.publishOutbox(userId, itemId, 'library.item.untagged', {
        tagId,
        itemId,
      });
    });
  }

  /**
   * Resolves or creates tags by name in bulk and upserts all ItemTag join records.
   * Uses 3 queries total regardless of tag count, replacing the previous N*3 sequential loop.
   */
  async syncTagsToItem(
    tx: Prisma.TransactionClient,
    userId: string,
    itemId: string,
    tagNames: string[],
  ): Promise<void> {
    if (tagNames.length === 0) return;

    // Normalize names for case-insensitive matching and deduplication
    const dedupedTags = normalizeTags(tagNames);
    if (dedupedTags.length === 0) return;

    // 1. Fetch all existing tags in one query
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

    // 2. Create missing tags in one batch preserving original casing
    const missingNames = dedupedTags.filter(
      (n) => !existingNameSet.has(n.toLowerCase()),
    );
    if (missingNames.length > 0) {
      await tx.tag.createMany({
        data: missingNames.map((name) => ({ userId, name })),
        skipDuplicates: true,
      });
    }

    // 3. Re-fetch to get IDs of newly created tags
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

    // 4. Upsert all join records in one batch
    await tx.itemTag.createMany({
      data: allTags.map((tag) => ({ tagId: tag.id, itemId })),
      skipDuplicates: true,
    });

    if (missingNames.length > 0) {
      await this.invalidateTagsCache(userId);
    }
  }

  /**
   * Domain merge helper: consolidates tags from source duplicate items to a target item.
   */
  async mergeTagsToItem(
    tx: Prisma.TransactionClient,
    sourceItemIds: string[],
    targetItemId: string,
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
