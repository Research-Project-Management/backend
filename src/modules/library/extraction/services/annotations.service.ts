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
  AnnotationEntity,
} from '@/modules/library/core/types/extraction.types';
import { AnnotationNormalizer } from '@/modules/library/extraction/domain/annotations.domain';
import {
  TransactionHelpers,
  ITEM_CACHE_INVALIDATOR,
  IItemCacheInvalidator,
  CATALOG_FACADE,
  ICatalogFacade,
  executeStandardLibraryCacheInvalidation,
  UNIT_OF_WORK,
  IUnitOfWork,
  LIBRARY_EVENT_TYPES,
  isUuid,
  SingleFlightCoalescer,
} from '@/modules/library/core';
import { AttachmentsService } from './attachments.service';

@Injectable()
export class AnnotationsService {
  private readonly singleFlight = new SingleFlightCoalescer();

  constructor(
    private readonly annotationsRepo: AnnotationsRepository,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx: IUnitOfWork,
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
    await executeStandardLibraryCacheInvalidation(
      this.cacheCoordinator ?? this.catalogGateway,
      this.cache,
      {
        userId,
        projectId,
        itemIds: itemId ? [itemId] : undefined,
        extraKeys: [`library:attachment:${attachmentId}:annotations`],
        preserveContentCaches: true,
      },
    );
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

    const cacheKey = `library:attachment:${attachmentId}:annotations`;
    if (this.cache) {
      try {
        const cached = await this.cache.get<AnnotationEntity[]>(cacheKey);
        if (Array.isArray(cached)) {
          return cached.filter(
            (a) =>
              (pageIndex === undefined || a.pageIndex === pageIndex) &&
              (type === undefined || a.type === type),
          );
        }
      } catch {
        // Fallback to DB on cache read failure
      }
    }

    if (pageIndex === undefined && type === undefined) {
      return this.singleFlight.execute(cacheKey, async () => {
        const all = await this.annotationsRepo.findByAttachment(attachmentId);
        if (this.cache) {
          try {
            await this.cache.set(cacheKey, all, 300);
          } catch {
            // Ignore cache write errors
          }
        }
        return all;
      });
    }

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
    let postCommitRegistered = false;
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

        const normalized = this.normalizer.normalizeCreateData({
          ...data,
          ...(resolvedItemId ? { itemId: resolvedItemId } : {}),
        });
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
          LIBRARY_EVENT_TYPES.ANNOTATION_CREATED,
          created,
        );

        if (helpers?.onAfterCommit) {
          postCommitRegistered = true;
          helpers.onAfterCommit(() =>
            this.invalidateCache(
              data.attachmentId,
              resolvedItemId,
              userId,
              resolvedProjectId,
            ),
          );
        }

        return created;
      },
    );
    if (!postCommitRegistered) {
      await this.invalidateCache(
        data.attachmentId,
        resolvedItemId,
        userId,
        resolvedProjectId,
      );
    }
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
    let postCommitRegistered = false;
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

        await this.assertCanModifyAnnotation(
          userId,
          existing,
          effectiveProjectId,
          false,
          tx,
        );

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
          LIBRARY_EVENT_TYPES.ANNOTATION_UPDATED,
          result,
        );

        if (resolvedAttachmentId && helpers?.onAfterCommit) {
          const targetAttId = resolvedAttachmentId;
          postCommitRegistered = true;
          helpers.onAfterCommit(() =>
            this.invalidateCache(
              targetAttId,
              resolvedItemId,
              userId,
              resolvedProjectId,
            ),
          );
        }

        return result;
      },
    );
    if (!postCommitRegistered && resolvedAttachmentId) {
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
    let postCommitRegistered = false;
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

        await this.assertCanModifyAnnotation(
          userId,
          existing,
          effectiveProjectId,
          true,
          tx,
        );

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
            LIBRARY_EVENT_TYPES.ANNOTATION_DELETED,
            {
              id,
              attachmentId: existing.attachmentId,
              itemId: attachment?.itemId,
              deletedAt: new Date(),
            },
          );

          if (resolvedAttachmentId && helpers?.onAfterCommit) {
            const targetAttId = resolvedAttachmentId;
            postCommitRegistered = true;
            helpers.onAfterCommit(() =>
              this.invalidateCache(
                targetAttId,
                resolvedItemId,
                userId,
                resolvedProjectId,
              ),
            );
          }
        }

        return isDeleted;
      },
    );
    if (deleted && resolvedAttachmentId && !postCommitRegistered) {
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
    let postCommitRegistered = false;

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
            if (item.id) {
              const normUpdate = this.normalizer.normalizeUpdateData({
                type: item.type,
                pageLabel: item.pageLabel,
                annotationSortIndex: item.annotationSortIndex,
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
              pageLabel: item.pageLabel,
              annotationSortIndex: item.annotationSortIndex,
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
              pageLabel: normCreate.pageLabel,
              annotationSortIndex: normCreate.annotationSortIndex,
              color: normCreate.color,
              quoteText: normCreate.quoteText,
              comment: normCreate.comment,
              tags: normCreate.tags,
              rectCoords: normCreate.rectCoords,
            };
          },
        );

        const isAdmin =
          effectiveProjectId && data.deletes.length > 0
            ? await this.annotationsRepo.isProjectAdmin(
                userId,
                effectiveProjectId,
                tx,
              )
            : false;

        const result = await this.annotationsRepo.batchUpsert(
          attachmentId,
          userId,
          normalizedUpserts,
          data.deletes,
          tx,
          resolvedItemId,
          isAdmin,
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
            eventType: LIBRARY_EVENT_TYPES.ANNOTATION_CREATED,
            payload: annotation,
          })),
          ...result.updated.map((annotation) => ({
            userId,
            projectId: effectiveProjectId,
            aggregateId: annotation.id,
            eventType: LIBRARY_EVENT_TYPES.ANNOTATION_UPDATED,
            payload: annotation,
          })),
          ...result.deleted.map((id) => ({
            userId,
            projectId: effectiveProjectId,
            aggregateId: id,
            eventType: LIBRARY_EVENT_TYPES.ANNOTATION_DELETED,
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

        if (helpers?.onAfterCommit) {
          postCommitRegistered = true;
          helpers.onAfterCommit(() =>
            this.invalidateCache(
              attachmentId,
              resolvedItemId,
              userId,
              resolvedProjectId,
            ),
          );
        }

        return result;
      },
    );
    if (!postCommitRegistered) {
      await this.invalidateCache(
        attachmentId,
        resolvedItemId,
        userId,
        resolvedProjectId,
      );
    }
    return batchResult;
  }

  // Auth helpers

  private async assertCanModifyAnnotation(
    userId: string,
    annotation: { authorId?: string | null },
    projectId?: string,
    isDelete = false,
    tx?: Prisma.TransactionClient,
  ) {
    if (annotation.authorId === userId) {
      return;
    }
    if (isDelete && projectId && isUuid(projectId)) {
      const isAdmin = await this.annotationsRepo.isProjectAdmin(
        userId,
        projectId,
        tx,
      );
      if (isAdmin) {
        return;
      }
    }
    throw new ForbiddenException(
      'Only the annotation author (or project owner/coordinator) can modify or delete this annotation',
    );
  }
}
