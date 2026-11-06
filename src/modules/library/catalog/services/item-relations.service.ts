import { Injectable, Inject, Logger, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { RedisCacheService } from '@/core';
import { QueryRepository, hydrateOffloadedMetadataPayload } from '@/modules/library/catalog/repositories/query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { ItemDetail } from '@/modules/library/core/types/bibliographic.types';
import { LIBRARY_EVENT_TYPES, TransactionHelpers, UNIT_OF_WORK, IUnitOfWork, normalizeProjectScopeId, executeStandardLibraryCacheInvalidation, libraryConfig, SingleFlightCoalescer, sortLockKeys } from '@/modules/library/core';
import { ItemCacheCoordinator } from './schema-validator.service';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/config/library.config';
import { DocumentFulltextResponse } from '@/modules/library/catalog/dto/items.dto';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';

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
    const [item, relations] = await Promise.all([
      this.query.findById(userId, itemId, projectId),
      this.query.getRelations(itemId),
    ]);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

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
    const targetIds = sortLockKeys(
      rawIds.filter((id) => id && id !== sourceItemId),
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
              const persisted = await this.command.putRelation(sourceItemId, relation, tx);
              if (!persisted?.id) {
                throw new BadRequestException(
                  `Cannot link item ${sourceItemId} to target item ${relation.targetItemId}: scope mismatch or item unavailable`,
                );
              }
              linkedRelations.push({
                ...relation,
                id: persisted.id,
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
          const persisted = await this.command.putRelation(sourceItemId, relation);
          if (persisted === null) {
            throw new BadRequestException(
              `Cannot link item ${sourceItemId} to target item ${relation.targetItemId}: scope mismatch or item unavailable`,
            );
          }
          linkedRelations.push({
            ...relation,
            id: persisted?.id || '',
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

const applyJitter = (ttl: number): number =>
  libraryConfig().app.isTest
    ? ttl
    : Math.max(1, Math.floor(ttl * (0.9 + Math.random() * 0.2)));

/**
 * ItemFulltextService — Dedicated Domain Service for Academic Document Intelligence.
 * Extracts, parses, and caches the structured academic full-text document tree (sections, figures, tables, formulas).
 * Feeds the Frontend Reader's DocumentNavDrawer and Outline.
 */
@Injectable()
export class ItemFulltextService {
  private readonly logger = new Logger(ItemFulltextService.name);
  private readonly singleFlight = new SingleFlightCoalescer();

  constructor(
    private readonly query: QueryRepository,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  /**
   * Retrieves the structured academic full-text document tree extracted by native PDF extraction pipelines.
   */
  async getFulltext(
    userId: string,
    id: string,
    projectId?: string,
    attachmentId?: string,
  ): Promise<DocumentFulltextResponse> {
    const trimmedAttachmentId = attachmentId?.trim() || undefined;
    const normalizedProj = normalizeProjectScopeId(projectId);
    const baseCacheKey = LIBRARY_REDIS_KEYS.itemFulltext(id);
    const cacheKey = trimmedAttachmentId
      ? `${baseCacheKey}:att:${trimmedAttachmentId}`
      : baseCacheKey;
    if (this.cache) {
      try {
        const cached = await this.cache.get<
          DocumentFulltextResponse & {
            userId?: string;
            projectId?: string | null;
          }
        >(cacheKey);
        const isAuthorizedCached =
          cached &&
          (normalizedProj
            ? cached.projectId === normalizedProj
            : !cached.projectId && cached.userId === userId);
        if (isAuthorizedCached) {
          if ('projectId' in cached && cached.projectId !== undefined) {
            const { projectId: _p, userId: _u, ...cleanCached } = cached;
            return cleanCached;
          }
          return cached;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Cache lookup error for ${cacheKey}: ${message}`);
      }
    }

    const item = this.query.findSummaryById
      ? await this.query.findSummaryById(userId, id, undefined, projectId)
      : await this.query.findById(userId, id, projectId, undefined, false);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found or access denied`);
    }

    const effectiveProjectId =
      normalizedProj ?? normalizeProjectScopeId(item.projectId) ?? null;
    const coalescingKey = `${cacheKey}:${effectiveProjectId || `user:${item.userId}`}`;

    return this.singleFlight.execute(coalescingKey, async () => {
      // 1. Look for authoritative full-text or header extraction record in a single query via QueryRepository
      const matchedRecord = trimmedAttachmentId
        ? await this.query.findItemMetadataByProviders(
            id,
            [
              'pdf_fulltext',
              'trusted_extraction',
              'ocr',
              'pdf_metadata',
            ],
            undefined,
            {
              userId: item.userId,
              projectId: item.projectId ?? null,
            },
            trimmedAttachmentId,
          )
        : await this.query.findItemMetadataByProviders(
            id,
            [
              'pdf_fulltext',
              'trusted_extraction',
              'ocr',
              'pdf_metadata',
            ],
            undefined,
            {
              userId: item.userId,
              projectId: item.projectId ?? null,
            },
          );

      const isFulltextProvider =
        matchedRecord && matchedRecord.sourceProvider !== 'pdf_metadata';

      let result: DocumentFulltextResponse;
      if (
        isFulltextProvider &&
        matchedRecord?.rawPayload &&
        typeof matchedRecord.rawPayload === 'object'
      ) {
        const payload = await hydrateOffloadedMetadataPayload(
          matchedRecord.rawPayload as Record<string, unknown>,
          this.storagePort,
          {
            userId: item.userId,
            projectId: item.projectId ?? undefined,
          },
          (msg) =>
            this.logger.warn(
              `Failed to download/decompress offloaded fulltext for item ${id}: ${msg}`,
            ),
        );

        result = {
          title:
            (typeof payload.title === 'string' ? payload.title : undefined) ||
            item.title,
          abstract:
            (typeof payload.abstract === 'string'
              ? payload.abstract
              : undefined) ||
            item.abstract ||
            undefined,
          sections: (Array.isArray(payload.sections)
            ? payload.sections
            : []) as DocumentFulltextResponse['sections'],
          figures: (Array.isArray(payload.figures)
            ? payload.figures
            : []) as DocumentFulltextResponse['figures'],
          tables: (Array.isArray(payload.tables)
            ? payload.tables
            : []) as DocumentFulltextResponse['tables'],
          formulas: (Array.isArray(payload.formulas)
            ? payload.formulas
            : []) as DocumentFulltextResponse['formulas'],
          references: (Array.isArray(payload.references)
            ? payload.references
            : []) as DocumentFulltextResponse['references'],
          ...(Array.isArray(payload.pages)
            ? {
                pages: (
                  payload.pages as Array<{
                    pageNumber?: number;
                    pageIndex?: number;
                    text?: string;
                    textContent?: string;
                  }>
                ).map((p, idx) => ({
                  pageNumber:
                    typeof p.pageNumber === 'number'
                      ? p.pageNumber
                      : typeof p.pageIndex === 'number'
                        ? p.pageIndex + 1
                        : idx + 1,
                  text:
                    typeof p.text === 'string'
                      ? p.text
                      : typeof p.textContent === 'string'
                        ? p.textContent
                        : '',
                })),
              }
            : {}),
          ...(typeof payload.markdown === 'string'
            ? { markdown: payload.markdown }
            : {}),
          ...(typeof payload.plainText === 'string'
            ? { plainText: payload.plainText }
            : {}),
          ...(typeof payload.pageCount === 'number'
            ? { pageCount: payload.pageCount }
            : {}),
        };
      } else if (
        matchedRecord?.rawPayload &&
        typeof matchedRecord.rawPayload === 'object'
      ) {
        // 2. Fallback to header/metadata extraction record ('pdf_metadata') if available
        const payload = matchedRecord.rawPayload as Record<string, unknown>;
        result = {
          title:
            (typeof payload.title === 'string' ? payload.title : undefined) ||
            item.title,
          abstract:
            (typeof payload.abstract === 'string'
              ? payload.abstract
              : undefined) ||
            item.abstract ||
            undefined,
          sections: [],
          figures: [],
          tables: [],
          formulas: [],
          references: (Array.isArray(payload.references)
            ? payload.references
            : []) as DocumentFulltextResponse['references'],
        };
      } else {
        // 3. Return clean empty structure instead of 404 so Reader renders gracefully
        result = {
          title: item.title,
          abstract: item.abstract || undefined,
          sections: [],
          figures: [],
          tables: [],
          formulas: [],
          references: [],
        };
      }

      if (this.cache) {
        try {
          const cachedPayload = effectiveProjectId
            ? {
                ...result,
                projectId: effectiveProjectId,
              }
            : {
                ...result,
                userId: item.userId,
                projectId: null,
              };
          const jitteredTtl = applyJitter(600);
          await this.cache.set(cacheKey, cachedPayload, jitteredTtl); // 10 min TTL with jitter
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.debug(`Cache set error for ${cacheKey}: ${message}`);
        }
      }

      return result;
    });
  }
}
