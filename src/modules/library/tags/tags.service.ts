import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TagsRepository } from './tags.repository';
import { TransactionService } from '../outbox/transaction.service';
import { normalizeTags } from './utils/tags.utils';

@Injectable()
export class TagsService {
  constructor(
    private readonly tagsRepo: TagsRepository,
    private readonly libraryTx: TransactionService,
  ) {}

  async getTags(workspaceId: string) {
    return this.tagsRepo.findMany(workspaceId);
  }

  async createOrGetTag(
    workspaceId: string,
    name: string,
    color?: string,
    type?: string,
  ) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const tag = await this.tagsRepo.create(
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
    });
  }

  async deleteTag(workspaceId: string, tagId: string) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const deleted = await this.tagsRepo.delete(workspaceId, tagId, tx);
      if (deleted) {
        await helpers.recordTombstone(workspaceId, {
          entityType: 'Tag',
          entityId: tagId,
        });

        await helpers.publishOutbox(workspaceId, tagId, 'library.tag.deleted', {
          id: tagId,
          deletedAt: new Date(),
        });
      }
      return deleted;
    });
  }

  async assignTag(workspaceId: string, tagId: string, catalogItemId: string) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      await this.tagsRepo.assignToItem(tagId, catalogItemId, tx);

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogItemTag',
        entityId: `${tagId}:${catalogItemId}`,
        action: 'create',
        version: 1,
        data: { tagId, catalogItemId },
      });

      await helpers.publishOutbox(
        workspaceId,
        catalogItemId,
        'library.item.tagged',
        { tagId, catalogItemId },
      );
    });
  }

  async removeTag(workspaceId: string, tagId: string, catalogItemId: string) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      await this.tagsRepo.removeFromItem(tagId, catalogItemId, tx);

      await helpers.recordTombstone(workspaceId, {
        entityType: 'CatalogItemTag',
        entityId: `${tagId}:${catalogItemId}`,
      });

      await helpers.publishOutbox(
        workspaceId,
        catalogItemId,
        'library.item.untagged',
        { tagId, catalogItemId },
      );
    });
  }

  /**
   * Resolves or creates tags by name in bulk and upserts all CatalogItemTag join records.
   * Uses 3 queries total regardless of tag count, replacing the previous N*3 sequential loop.
   */
  async syncTagsToItem(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    catalogItemId: string,
    tagNames: string[],
  ): Promise<void> {
    if (tagNames.length === 0) return;

    // Normalize names for case-insensitive matching and deduplication
    const dedupedTags = normalizeTags(tagNames);
    if (dedupedTags.length === 0) return;

    // 1. Fetch all existing tags in one query
    const existingTags = await tx.catalogTag.findMany({
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
    const missingNames = dedupedTags.filter((n) => !existingNameSet.has(n.toLowerCase()));
    if (missingNames.length > 0) {
      await tx.catalogTag.createMany({
        data: missingNames.map((name) => ({ workspaceId, name })),
        skipDuplicates: true,
      });
    }

    // 3. Re-fetch to get IDs of newly created tags
    const allTags =
      missingNames.length > 0
        ? await tx.catalogTag.findMany({
            where: {
              workspaceId,
              name: { in: dedupedTags, mode: 'insensitive' },
            },
            select: { id: true },
          })
        : existingTags;

    // 4. Upsert all join records in one batch
    await tx.catalogItemTag.createMany({
      data: allTags.map((tag) => ({ tagId: tag.id, catalogItemId })),
      skipDuplicates: true,
    });
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

    const primaryTags = await tx.catalogItemTag.findMany({
      where: { catalogItemId: targetItemId },
      select: { tagId: true },
    });
    const primaryTagIds = new Set(primaryTags.map((it) => it.tagId));

    const dupTags = await tx.catalogItemTag.findMany({
      where: { catalogItemId: { in: sourceItemIds } },
      select: { tagId: true },
    });

    for (const dup of dupTags) {
      if (!primaryTagIds.has(dup.tagId)) {
        await tx.catalogItemTag.upsert({
          where: {
            tagId_catalogItemId: {
              tagId: dup.tagId,
              catalogItemId: targetItemId,
            },
          },
          create: {
            catalogItemId: targetItemId,
            tagId: dup.tagId,
          },
          update: {},
        });
        primaryTagIds.add(dup.tagId);
      }
    }

    await tx.catalogItemTag.deleteMany({
      where: { catalogItemId: { in: sourceItemIds } },
    });
  }
}
