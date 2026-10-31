import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Optional,
  Inject,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisCacheService } from '@/core';
import { AnnotationsRepository } from '@/modules/library/extraction/repositories/annotations.repository';
import {
  CreateAnnotationData,
  UpdateAnnotationData,
  BatchAnnotationsData,
  BatchAnnotationsResult,
  AnnotationType,
  UpsertAnnotationItem,
} from '@/modules/library/extraction/types/annotations.types';
import { AnnotationNormalizer } from '@/modules/library/extraction/domain/annotation.normalizer';
import {
  TransactionHelpers,
  LIBRARY_REDIS_KEYS,
  ITEM_CACHE_INVALIDATOR,
  IItemCacheInvalidator,
  CATALOG_FACADE,
  ICatalogFacade,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { AttachmentsService } from './attachments.service';

@Injectable()
export class AnnotationsService {
  constructor(
    private readonly annotationsRepo: AnnotationsRepository,
    private readonly libraryTx: TransactionService,
    private readonly attachmentsService: AttachmentsService,
    private readonly normalizer: AnnotationNormalizer,
    @Optional()
    private readonly cache?: RedisCacheService,
    @Optional()
    @Inject(ITEM_CACHE_INVALIDATOR)
    private readonly cacheCoordinator?: IItemCacheInvalidator,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
  ) {}

  async invalidateCache(
    attachmentId: string,
    itemId?: string | null,
    userId?: string,
    projectId?: string,
  ): Promise<void> {
    if (itemId) {
      const invalidator =
        this.cacheCoordinator?.invalidateForWrite
          ? this.cacheCoordinator
          : this.catalogGateway?.invalidateForWrite
            ? this.catalogGateway
            : undefined;
      if (invalidator?.invalidateForWrite && userId) {
        try {
          await invalidator.invalidateForWrite({
            userId,
            projectId,
            itemIds: [itemId],
          });
        } catch {
          // Ignore cache invalidation errors
        }
      }
    }
    if (!this.cache) return;
    try {
      const tasks: Promise<unknown>[] = [
        this.cache.del(`library:attachment:${attachmentId}:annotations`),
      ];
      if (itemId) {
        tasks.push(
          this.cache.del(LIBRARY_REDIS_KEYS.item(itemId)),
          this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(itemId)),
          this.cache.del(LIBRARY_REDIS_KEYS.itemAttachments(itemId)),
        );
        if (typeof this.cache.delPattern === 'function') {
          tasks.push(
            this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(itemId)),
          );
        }
      }
      await Promise.all(tasks);
    } catch {
      // Ignore cache invalidation errors
    }
  }

  // Queries

  async getAnnotationsByAttachment(
    userId: string,
    attachmentId: string,
    pageIndex?: number,
    type?: AnnotationType,
    projectId?: string,
  ) {
    await this.attachmentsService.assertAttachmentExists(
      attachmentId,
      userId,
      undefined,
      projectId,
    );
    return this.annotationsRepo.findByAttachment(attachmentId, pageIndex, type);
  }

  async getAnnotation(userId: string, id: string, projectId?: string) {
    const annotation = await this.annotationsRepo.findById(id);
    if (!annotation) return null;
    await this.attachmentsService.assertAttachmentExists(
      annotation.attachmentId,
      userId,
      undefined,
      projectId,
    );
    return annotation;
  }

  // Mutations

  async createAnnotation(
    userId: string,
    data: CreateAnnotationData,
    projectId?: string,
  ) {
    let resolvedItemId: string | undefined;
    let resolvedProjectId: string | undefined;
    const annotation = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const attachment = await this.attachmentsService.assertAttachmentExists(
          data.attachmentId,
          userId,
          tx,
          projectId,
        );
        resolvedItemId = attachment?.itemId;
        const effectiveProjectId =
          projectId || attachment?.item?.projectId || undefined;
        resolvedProjectId = effectiveProjectId;
        const eventScope = { userId, projectId: effectiveProjectId };

        const normalized = this.normalizer.normalizeCreateData(data);
        const created = await this.annotationsRepo.create(normalized, tx);

        await helpers.appendChange(eventScope, {
          entityType: 'Annotation',
          entityId: created.id,
          action: 'create',
          version: created.version,
          data: created,
        });

        await helpers.publishOutbox(
          eventScope,
          created.id,
          'library.annotation.created',
          created,
        );

        return created;
      },
    );
    await this.invalidateCache(
      data.attachmentId,
      resolvedItemId,
      userId,
      resolvedProjectId,
    );
    return annotation;
  }

  async updateAnnotation(
    userId: string,
    id: string,
    expectedVersion: number,
    data: UpdateAnnotationData,
    projectId?: string,
    attachmentId?: string,
  ) {
    let resolvedAttachmentId = attachmentId;
    let resolvedItemId: string | undefined;
    let resolvedProjectId: string | undefined;
    const updated = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const existing = await this.annotationsRepo.findById(id, tx);
        if (!existing)
          throw new NotFoundException(`Annotation ${id} not found`);
        if (attachmentId && existing.attachmentId !== attachmentId) {
          throw new NotFoundException(
            `Annotation ${id} not found on attachment ${attachmentId}`,
          );
        }
        resolvedAttachmentId = existing.attachmentId;

        const attachment = await this.attachmentsService.assertAttachmentExists(
          existing.attachmentId,
          userId,
          tx,
          projectId,
        );
        resolvedItemId = attachment?.itemId;
        const effectiveProjectId =
          projectId || attachment?.item?.projectId || undefined;
        resolvedProjectId = effectiveProjectId;
        const eventScope = { userId, projectId: effectiveProjectId };

        this.assertCanModifyAnnotation(userId, existing);

        const normalizedData = this.normalizer.normalizeUpdateData(data);
        const result = await this.annotationsRepo.update(
          id,
          expectedVersion,
          normalizedData,
          tx,
          existing,
        );

        await helpers.appendChange(eventScope, {
          entityType: 'Annotation',
          entityId: result.id,
          action: 'update',
          version: result.version,
          data: result,
        });

        await helpers.publishOutbox(
          eventScope,
          result.id,
          'library.annotation.updated',
          result,
        );

        return result;
      },
    );
    if (resolvedAttachmentId) {
      await this.invalidateCache(
        resolvedAttachmentId,
        resolvedItemId,
        userId,
        resolvedProjectId,
      );
    }
    return updated;
  }

  async deleteAnnotation(
    userId: string,
    id: string,
    expectedVersion?: number,
    projectId?: string,
    attachmentId?: string,
  ) {
    let resolvedAttachmentId = attachmentId;
    let resolvedItemId: string | undefined;
    let resolvedProjectId: string | undefined;
    const deleted = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const existing = await this.annotationsRepo.findById(id, tx);
        if (!existing)
          throw new NotFoundException(`Annotation ${id} not found`);
        if (attachmentId && existing.attachmentId !== attachmentId) {
          throw new NotFoundException(
            `Annotation ${id} not found on attachment ${attachmentId}`,
          );
        }
        resolvedAttachmentId = existing.attachmentId;

        const attachment = await this.attachmentsService.assertAttachmentExists(
          existing.attachmentId,
          userId,
          tx,
          projectId,
        );
        resolvedItemId = attachment?.itemId;
        const effectiveProjectId =
          projectId || attachment?.item?.projectId || undefined;
        resolvedProjectId = effectiveProjectId;
        const eventScope = { userId, projectId: effectiveProjectId };

        this.assertCanModifyAnnotation(userId, existing);

        const isDeleted = await this.annotationsRepo.softDelete(
          id,
          expectedVersion,
          tx,
          existing,
        );

        if (isDeleted) {
          await helpers.appendChange(eventScope, {
            entityType: 'Annotation',
            entityId: id,
            action: 'delete',
            version: existing.version,
            data: {
              id,
              attachmentId: existing.attachmentId,
              itemId: attachment?.itemId,
            },
          });

          await helpers.recordTombstone(eventScope, {
            entityType: 'Annotation',
            entityId: id,
          });

          await helpers.publishOutbox(
            eventScope,
            id,
            'library.annotation.deleted',
            {
              id,
              attachmentId: existing.attachmentId,
              itemId: attachment?.itemId,
              deletedAt: new Date(),
            },
          );
        }

        return isDeleted;
      },
    );
    if (deleted && resolvedAttachmentId) {
      await this.invalidateCache(
        resolvedAttachmentId,
        resolvedItemId,
        userId,
        resolvedProjectId,
      );
    }
    return deleted;
  }

  // Batch

  async batchUpsertAnnotations(
    userId: string,
    attachmentId: string,
    data: BatchAnnotationsData,
    projectId?: string,
  ): Promise<BatchAnnotationsResult> {
    if (data.upserts.length === 0 && data.deletes.length === 0) {
      return { created: [], updated: [], deleted: [] };
    }

    let resolvedItemId: string | undefined;
    let resolvedProjectId: string | undefined;

    const batchResult = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const attachment = await this.attachmentsService.assertAttachmentExists(
          attachmentId,
          userId,
          tx,
          projectId,
        );
        resolvedItemId = attachment?.itemId;
        const effectiveProjectId =
          projectId || attachment?.item?.projectId || undefined;
        resolvedProjectId = effectiveProjectId;
        const eventScope = { userId, projectId: effectiveProjectId };

        const normalizedUpserts: UpsertAnnotationItem[] = data.upserts.map(
          (item) => {
            if (item.id && item.expectedVersion !== undefined) {
              const normUpdate = this.normalizer.normalizeUpdateData({
                color: item.color,
                quoteText: item.quoteText,
                comment: item.comment,
                tags: item.tags,
                rectCoords: item.rectCoords,
                y: item.y,
                x: item.x,
              });
              return {
                ...item,
                ...normUpdate,
                ...(item.type !== undefined
                  ? { type: this.normalizer.parseType(item.type) }
                  : {}),
              };
            }
            const normCreate = this.normalizer.normalizeCreateData({
              id: item.id,
              attachmentId,
              type: item.type,
              pageIndex: item.pageIndex,
              y: item.y,
              x: item.x,
              color: item.color,
              quoteText: item.quoteText,
              comment: item.comment,
              tags: item.tags,
              rectCoords: item.rectCoords,
              authorId: userId,
            });
            return {
              ...item,
              type: normCreate.type,
              color: normCreate.color,
              quoteText: normCreate.quoteText,
              comment: normCreate.comment,
              tags: normCreate.tags,
              rectCoords: normCreate.rectCoords,
            };
          },
        );

        const result = await this.annotationsRepo.batchUpsert(
          attachmentId,
          userId,
          normalizedUpserts,
          data.deletes,
          tx,
        );

        const changes: Array<{
          entityType: string;
          entityId: string;
          action: 'create' | 'update' | 'delete';
          version: number;
          data: unknown;
        }> = [
          ...result.created.map((annotation) => ({
            entityType: 'Annotation',
            entityId: annotation.id,
            action: 'create' as const,
            version: annotation.version,
            data: annotation,
          })),
          ...result.updated.map((annotation) => ({
            entityType: 'Annotation',
            entityId: annotation.id,
            action: 'update' as const,
            version: annotation.version,
            data: annotation,
          })),
          ...result.deleted.map((id) => ({
            entityType: 'Annotation',
            entityId: id,
            action: 'delete' as const,
            version: 0,
            data: {
              id,
              attachmentId,
              itemId: attachment?.itemId,
            },
          })),
        ];

        if (changes.length > 0) {
          if (helpers.appendChangesBatch) {
            await helpers.appendChangesBatch(eventScope, changes);
          } else {
            for (const change of changes) {
              await helpers.appendChange(eventScope, change);
            }
          }
        }

        if (result.deleted.length > 0) {
          if (helpers.recordTombstonesBatch) {
            await helpers.recordTombstonesBatch(
              eventScope,
              result.deleted.map((id) => ({
                entityType: 'Annotation',
                entityId: id,
              })),
            );
          } else {
            for (const id of result.deleted) {
              await helpers.recordTombstone(eventScope, {
                entityType: 'Annotation',
                entityId: id,
              });
            }
          }
        }

        const deletedAt = new Date();
        const outboxEvents: Array<{
          userId: string;
          projectId?: string;
          aggregateId: string;
          eventType: string;
          payload: unknown;
        }> = [
          ...result.created.map((annotation) => ({
            userId,
            projectId: effectiveProjectId,
            aggregateId: annotation.id,
            eventType: 'library.annotation.created',
            payload: annotation,
          })),
          ...result.updated.map((annotation) => ({
            userId,
            projectId: effectiveProjectId,
            aggregateId: annotation.id,
            eventType: 'library.annotation.updated',
            payload: annotation,
          })),
          ...result.deleted.map((id) => ({
            userId,
            projectId: effectiveProjectId,
            aggregateId: id,
            eventType: 'library.annotation.deleted',
            payload: {
              id,
              attachmentId,
              itemId: attachment?.itemId,
              deletedAt,
            },
          })),
        ];

        if (outboxEvents.length > 0) {
          if (helpers.publishOutboxBatch) {
            await helpers.publishOutboxBatch(outboxEvents);
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
        }

        return result;
      },
    );
    await this.invalidateCache(
      attachmentId,
      resolvedItemId,
      userId,
      resolvedProjectId,
    );
    return batchResult;
  }

  // Auth helpers

  private assertCanModifyAnnotation(
    userId: string,
    annotation: { authorId?: string | null },
  ) {
    if (annotation.authorId !== userId) {
      throw new ForbiddenException(
        'Only the annotation author can modify or delete this annotation',
      );
    }
  }
}
