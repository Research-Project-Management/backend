import {
  Injectable,
  Inject,
  Optional,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, TagType } from '@prisma/client';
import { TagsRepository } from '@/modules/library/catalog/repositories/tags.repository';
import {
  normalizeProjectScopeId,
  libraryConfig,
  LIBRARY_EVENT_TYPES,
  UNIT_OF_WORK,
  IUnitOfWork,
  executeStandardLibraryCacheInvalidation,
  SingleFlightCoalescer,
  UserId,
  TagId,
  ItemId,
  ProjectId,
} from '@/modules/library/core';
import { cleanSingleTag } from '@/modules/library/core/domain/tag.domain';

import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/config/library.config';
import { ItemCacheCoordinator } from './schema-validator.service';

@Injectable()
export class TagsService {
  private readonly singleFlight = new SingleFlightCoalescer();

  private applyJitter(ttl: number): number {
    return libraryConfig().app.isTest
      ? ttl
      : Math.max(1, Math.floor(ttl * (0.9 + Math.random() * 0.2)));
  }

  constructor(
    private readonly repo: TagsRepository,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx: IUnitOfWork,
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
        : undefined;
    await executeStandardLibraryCacheInvalidation(
      this.cacheCoordinator,
      this.cache,
      {
        userId: String(userId),
        projectId: projectId ? String(projectId) : undefined,
        itemIds,
      },
    );
  }

  async getTags(
    userId: UserId | string,
    options?: { includeInactive?: boolean; projectId?: ProjectId | string },
  ) {
    const validProjectId = normalizeProjectScopeId(options?.projectId);
    const scopeKey = validProjectId ? `proj:${validProjectId}` : userId;
    const cacheKey = options?.includeInactive
      ? `${LIBRARY_REDIS_KEYS.tags(scopeKey)}:all`
      : LIBRARY_REDIS_KEYS.tags(scopeKey);
    return this.singleFlight.execute(cacheKey, () =>
      this.cache
        ? this.cache.wrap(
            cacheKey,
            () => this.repo.findMany(userId, options),
            this.applyJitter(300),
          )
        : this.repo.findMany(userId, options),
    );
  }

  async createOrGetTag(
    userId: UserId | string,
    name: string,
    color?: string,
    type?: TagType,
    projectId?: ProjectId | string | null,
    shortcut?: number | null,
  ) {
    const cleanName = cleanSingleTag(name, {
      allowManualAcademicTerms: type !== TagType.automatic,
    });
    if (!cleanName) {
      throw new BadRequestException(
        `Invalid or disallowed tag name: "${name}"`,
      );
    }
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    let ranPostCommitHook = false;
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers?.onAfterCommit);
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
        const isExistingUpdate = typeof tag.version === 'number' && tag.version > 1;

        await helpers.appendChange(eventScope, {
          entityType: 'Tag',
          entityId: tag.id,
          action: isExistingUpdate ? 'update' : 'create',
          version: tag.version ?? 1,
          data: tag,
        });

        await helpers.publishOutbox(
          eventScope,
          tag.id,
          isExistingUpdate
            ? LIBRARY_EVENT_TYPES.TAG_UPDATED
            : LIBRARY_EVENT_TYPES.TAG_CREATED,
          tag,
        );

        helpers?.onAfterCommit?.(() =>
          this.invalidateTagsCache(userId, effectiveProjectId),
        );

        return tag;
      },
    );

    if (!ranPostCommitHook) {
      await this.invalidateTagsCache(userId, effectiveProjectId);
    }
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
      const cleanName = cleanSingleTag(data.name, {
        allowManualAcademicTerms: data.type !== TagType.automatic,
      });
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
    let ranPostCommitHook = false;
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers?.onAfterCommit);
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

        helpers?.onAfterCommit?.(() =>
          this.invalidateTagsCache(userId, effectiveProjectId, affectedItemIds),
        );

        return updated;
      },
    );

    if (!ranPostCommitHook) {
      await this.invalidateTagsCache(userId, effectiveProjectId, affectedItemIds);
    }
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
    let ranPostCommitHook = false;
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers?.onAfterCommit);
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
          await helpers.appendChange(eventScope, {
            entityType: 'Tag',
            entityId: tagId,
            action: 'delete',
            version: 0,
            data: { id: tagId, deleted: true },
          });
          await helpers.publishOutbox(
            eventScope,
            tagId,
            LIBRARY_EVENT_TYPES.TAG_DELETED,
            { id: tagId, deletedAt: new Date(), projectId: effectiveProjectId },
          );
        }
        helpers?.onAfterCommit?.(() =>
          this.invalidateTagsCache(userId, effectiveProjectId, affectedItemIds),
        );
        return deleted;
      },
    );

    if (!ranPostCommitHook) {
      await this.invalidateTagsCache(userId, effectiveProjectId, affectedItemIds);
    }
    return result;
  }

  async deleteAutomaticTags(
    userId: UserId | string,
    projectId?: ProjectId | string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const eventScope = { userId, projectId: effectiveProjectId };

    let ranPostCommitHook = false;
    let affectedItemIds: string[] = [];
    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
        ranPostCommitHook = Boolean(helpers?.onAfterCommit);
        if (this.repo.findAutomaticTagItemIds) {
          affectedItemIds = await this.repo.findAutomaticTagItemIds(
            userId,
            tx,
            effectiveProjectId,
          );
        }
        const deletedTagIds = await this.repo.deleteAutomatic(
          userId,
          tx,
          effectiveProjectId,
        );
        if (deletedTagIds.length > 0) {
          if (affectedItemIds.length === 0) {
            affectedItemIds = await this.repo.findItemIdsByTagIds(deletedTagIds, tx);
          }
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
        helpers?.onAfterCommit?.(() =>
          this.invalidateTagsCache(userId, effectiveProjectId, affectedItemIds),
        );
        return { count: deletedTagIds.length };
      },
    );

    if (!ranPostCommitHook) {
      await this.invalidateTagsCache(userId, effectiveProjectId, affectedItemIds);
    }
    return result;
  }

  async assignTag(
    userId: UserId | string,
    tagId: TagId | string,
    itemId: ItemId | string,
    projectId?: ProjectId | string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(projectId);

    let ranPostCommitHook = false;
    await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      ranPostCommitHook = Boolean(helpers?.onAfterCommit);
      if (this.repo?.assignTagToItem) {
        await this.repo.assignTagToItem(
          userId,
          tagId,
          itemId,
          effectiveProjectId,
          tx,
        );
      } else {
        const spaceId = effectiveProjectId || userId;
        const tagWhere: Prisma.LibraryTagWhereInput = { id: tagId, spaceId };
        const itemWhere: Prisma.LibraryItemWhereInput = {
          id: itemId,
          spaceId,
          deletedAt: null,
        };

        const [tag, item] = await Promise.all([
          tx.libraryTag.findFirst({
            where: tagWhere,
            select: { id: true },
          }),
          tx.libraryItem.findFirst({
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
      helpers?.onAfterCommit?.(() =>
        this.invalidateTagsCache(userId, effectiveProjectId, itemId),
      );
    });

    if (!ranPostCommitHook) {
      await this.invalidateTagsCache(userId, effectiveProjectId, itemId);
    }
  }

  async removeTag(
    userId: UserId | string,
    tagId: TagId | string,
    itemId: ItemId | string,
    projectId?: ProjectId | string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(projectId);

    let ranPostCommitHook = false;
    await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      ranPostCommitHook = Boolean(helpers?.onAfterCommit);
      if (this.repo?.removeTagFromItem) {
        await this.repo.removeTagFromItem(
          userId,
          tagId,
          itemId,
          effectiveProjectId,
          tx,
        );
      } else {
        const spaceId = effectiveProjectId || userId;
        const tagWhere: Prisma.LibraryTagWhereInput = { id: tagId, spaceId };
        const itemWhere: Prisma.LibraryItemWhereInput = {
          id: itemId,
          spaceId,
          deletedAt: null,
        };

        const [tag, item] = await Promise.all([
          tx.libraryTag.findFirst({
            where: tagWhere,
            select: { id: true },
          }),
          tx.libraryItem.findFirst({
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
      await helpers.appendChange(eventScope, {
        entityType: 'ItemTag',
        entityId: `${tagId}:${itemId}`,
        action: 'delete',
        version: 0,
        data: { tagId, itemId, deleted: true },
      });
      await helpers.publishOutbox(
        eventScope,
        itemId,
        LIBRARY_EVENT_TYPES.ITEM_UNTAGGED,
        { tagId, itemId, projectId: effectiveProjectId },
      );
      helpers?.onAfterCommit?.(() =>
        this.invalidateTagsCache(userId, effectiveProjectId, itemId),
      );
    });

    if (!ranPostCommitHook) {
      await this.invalidateTagsCache(userId, effectiveProjectId, itemId);
    }
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
      tx.libraryItemTag.findMany({ where: { itemId: targetItemId }, select: { tagId: true } }),
      tx.libraryItemTag.findMany({ where: { itemId: { in: sourceItemIds } }, select: { tagId: true } }),
    ]);
    const primaryTagIds = new Set(primaryTags.map((it) => it.tagId));
    const newTagIds = Array.from(
      new Set(dupTags.map((dup) => dup.tagId).filter((tagId) => !primaryTagIds.has(tagId))),
    );
    if (newTagIds.length > 0) {
      await tx.libraryItemTag.createMany({
        data: newTagIds.map((tagId) => ({ itemId: targetItemId, tagId })),
        skipDuplicates: true,
      });
    }
    await tx.libraryItemTag.deleteMany({ where: { itemId: { in: sourceItemIds } } });
  }

  async splitTag(
    userId: UserId | string,
    tagId: TagId | string,
    rawParts: string[],
    projectId?: ProjectId | string,
  ) {
    const cleanParts = Array.from(
      new Set(
        (rawParts || [])
          .map((p) =>
            cleanSingleTag(String(p || ''), { allowManualAcademicTerms: true }),
          )
          .filter((p): p is string => Boolean(p)),
      ),
    );
    if (cleanParts.length < 2) {
      throw new BadRequestException(
        'At least 2 distinct valid tag names are required to split a tag',
      );
    }

    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const eventScope = { userId, projectId: effectiveProjectId };
    let affectedItemIds: string[] = [];
    let ranPostCommitHook = false;

    const tags = await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      ranPostCommitHook = Boolean(helpers?.onAfterCommit);
      const splitRes = await this.repo.splitTag(
        String(userId),
        String(tagId),
        cleanParts,
        tx,
        effectiveProjectId,
      );
      if (!splitRes) {
        throw new NotFoundException(`Tag ${tagId} not found`);
      }
      affectedItemIds = splitRes.affectedItemIds;

      if (splitRes.mergedFromTagId) {
        await helpers.recordTombstone(eventScope, {
          entityType: 'Tag',
          entityId: splitRes.mergedFromTagId,
        });
      }

      const changeEntries = splitRes.tags.map((tag, idx) => ({
        entityType: 'Tag' as const,
        entityId: tag.id,
        action: (idx === 0 ? 'update' : 'create') as 'update' | 'create',
        version: (tag as { version?: number }).version ?? 1,
        data: tag,
      }));
      const outboxEvents = splitRes.tags.map((tag, idx) => ({
        aggregateId: tag.id,
        eventType:
          idx === 0
            ? LIBRARY_EVENT_TYPES.TAG_UPDATED
            : LIBRARY_EVENT_TYPES.TAG_CREATED,
        payload: tag,
      }));

      if (helpers.appendChangesBatch) {
        await helpers.appendChangesBatch(eventScope, changeEntries);
      } else {
        for (const entry of changeEntries) {
          await helpers.appendChange(eventScope, entry);
        }
      }

      if (helpers.publishOutboxBatch) {
        await helpers.publishOutboxBatch(eventScope, outboxEvents);
      } else {
        for (const ev of outboxEvents) {
          await helpers.publishOutbox(
            eventScope,
            ev.aggregateId,
            ev.eventType,
            ev.payload,
          );
        }
      }

      helpers?.onAfterCommit?.(() =>
        this.invalidateTagsCache(userId, effectiveProjectId, affectedItemIds),
      );
      return splitRes.tags;
    });

    if (!ranPostCommitHook) {
      await this.invalidateTagsCache(userId, effectiveProjectId, affectedItemIds);
    }
    return { tags, count: tags.length };
  }
}
