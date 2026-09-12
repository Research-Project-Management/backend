import { Injectable, Optional, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TagsRepository } from './tags.repository';
import { TransactionService } from '../outbox/transaction.service';
import { normalizeTags } from './utils/tags.utils';
import { RedisCacheService } from '../../../core/cache/redis-cache.service';
import { LIBRARY_REDIS_KEYS } from '../common/constants/redis-keys.constant';

@Injectable()
export class TagsService {
  constructor(
    private readonly repo: TagsRepository,
    private readonly libraryTx: TransactionService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  async invalidateTagsCache(workspaceId: string): Promise<void> {
    if (this.cache) {
      await this.cache.delPattern(LIBRARY_REDIS_KEYS.tagsPattern(workspaceId));
    }
  }

  async getTags(workspaceId: string, options?: { includeInactive?: boolean }) {
    if (this.cache) {
      const cacheKey = options?.includeInactive
        ? `${LIBRARY_REDIS_KEYS.tags(workspaceId)}:all`
        : LIBRARY_REDIS_KEYS.tags(workspaceId);
      return this.cache.wrap(
        cacheKey,
        () => this.repo.findMany(workspaceId, options),
        300,
      );
    }
    return this.repo.findMany(workspaceId, options);
  }

  async createOrGetTag(
    workspaceId: string,
    name: string,
    color?: string,
    type?: string,
  ) {
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const tag = await this.repo.create(
          workspaceId,
          name.trim(),
          color,
          type,
          tx,
        );

        await helpers.appendChange(workspaceId, {
          entityType: 'Tag',
          entityId: tag.id,
          action: 'create',
          version: 1,
          data: tag,
        });

        await helpers.publishOutbox(
          workspaceId,
          tag.id,
          'library.tag.created',
          tag,
        );

        return tag;
      },
    );

    await this.invalidateTagsCache(workspaceId);
    return result;
  }

  async deleteTag(workspaceId: string, tagId: string) {
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const deleted = await this.repo.delete(workspaceId, tagId, tx);
        if (deleted) {
          await helpers.recordTombstone(workspaceId, {
            entityType: 'Tag',
            entityId: tagId,
          });

          await helpers.publishOutbox(
            workspaceId,
            tagId,
            'library.tag.deleted',
            {
              id: tagId,
              deletedAt: new Date(),
            },
          );
        }
        return deleted;
      },
    );

    await this.invalidateTagsCache(workspaceId);
    return result;
  }

  async deleteAutomaticTags(workspaceId: string) {
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        const deletedTagIds = await this.repo.deleteAutomatic(workspaceId, tx);
        for (const tagId of deletedTagIds) {
          await helpers.recordTombstone(workspaceId, {
            entityType: 'Tag',
            entityId: tagId,
          });
          await helpers.publishOutbox(
            workspaceId,
            tagId,
            'library.tag.deleted',
            { id: tagId, deletedAt: new Date() },
          );
        }
        return { count: deletedTagIds.length };
      },
    );

    await this.invalidateTagsCache(workspaceId);
    return result;
  }

  async assignTag(workspaceId: string, tagId: string, itemId: string) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      // 1. Verify tag belongs to workspace (prevent IDOR / BOLA)
      const tag = await tx.tag.findFirst({
        where: { id: tagId, workspaceId },
        select: { id: true },
      });
      if (!tag) {
        throw new NotFoundException(`Tag ${tagId} not found in workspace`);
      }

      // 2. Verify item belongs to workspace (prevent IDOR / BOLA)
      const item = await tx.item.findFirst({
        where: { id: itemId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!item) {
        throw new NotFoundException(`Item ${itemId} not found in workspace`);
      }

      await this.repo.assignToItem(tagId, itemId, tx);

      await helpers.appendChange(workspaceId, {
        entityType: 'ItemTag',
        entityId: `${tagId}:${itemId}`,
        action: 'create',
        version: 1,
        data: { tagId, itemId },
      });

      await helpers.publishOutbox(workspaceId, itemId, 'library.item.tagged', {
        tagId,
        itemId,
      });
    });
  }

  async removeTag(workspaceId: string, tagId: string, itemId: string) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      // 1. Verify tag belongs to workspace (prevent IDOR / BOLA)
      const tag = await tx.tag.findFirst({
        where: { id: tagId, workspaceId },
        select: { id: true },
      });
      if (!tag) {
        throw new NotFoundException(`Tag ${tagId} not found in workspace`);
      }

      // 2. Verify item belongs to workspace (prevent IDOR / BOLA)
      const item = await tx.item.findFirst({
        where: { id: itemId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!item) {
        throw new NotFoundException(`Item ${itemId} not found in workspace`);
      }

      await this.repo.removeFromItem(tagId, itemId, tx);

      await helpers.recordTombstone(workspaceId, {
        entityType: 'ItemTag',
        entityId: `${tagId}:${itemId}`,
      });

      await helpers.publishOutbox(
        workspaceId,
        itemId,
        'library.item.untagged',
        { tagId, itemId },
      );
    });
  }

  /**
   * Resolves or creates tags by name in bulk and upserts all ItemTag join records.
   * Uses 3 queries total regardless of tag count, replacing the previous N*3 sequential loop.
   */
  async syncTagsToItem(
    tx: Prisma.TransactionClient,
    workspaceId: string,
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
        workspaceId,
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
        data: missingNames.map((name) => ({ workspaceId, name })),
        skipDuplicates: true,
      });
    }

    // 3. Re-fetch to get IDs of newly created tags
    const allTags =
      missingNames.length > 0
        ? await tx.tag.findMany({
            where: {
              workspaceId,
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
      await this.invalidateTagsCache(workspaceId);
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
