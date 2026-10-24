import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnnotationsRepository } from '@/modules/library/extraction/repositories/annotations.repository';
import {
  CreateAnnotationData,
  UpdateAnnotationData,
  BatchAnnotationsData,
  BatchAnnotationsResult,
  AnnotationType,
} from '@/modules/library/extraction/types/annotations.types';
import { AnnotationNormalizer } from '@/modules/library/extraction/domain/annotation.normalizer';
import { TransactionHelpers } from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { AttachmentsService } from './attachments.service';

@Injectable()
export class AnnotationsService {
  constructor(
    private readonly annotationsRepo: AnnotationsRepository,
    private readonly libraryTx: TransactionService,
    private readonly attachmentsService: AttachmentsService,
    private readonly normalizer: AnnotationNormalizer,
  ) {}

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
    return this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const attachment = await this.attachmentsService.assertAttachmentExists(
          data.attachmentId,
          userId,
          tx,
          projectId,
        );
        const effectiveProjectId =
          projectId || attachment?.item?.projectId || undefined;
        const eventScope = { userId, projectId: effectiveProjectId };

        const normalized = this.normalizer.normalizeCreateData(data);
        const annotation = await this.annotationsRepo.create(normalized, tx);

        await helpers.appendChange(eventScope, {
          entityType: 'Annotation',
          entityId: annotation.id,
          action: 'create',
          version: annotation.version,
          data: annotation,
        });

        await helpers.publishOutbox(
          eventScope,
          annotation.id,
          'library.annotation.created',
          annotation,
        );

        return annotation;
      },
    );
  }

  async updateAnnotation(
    userId: string,
    id: string,
    expectedVersion: number,
    data: UpdateAnnotationData,
    projectId?: string,
  ) {
    return this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const existing = await this.annotationsRepo.findById(id, tx);
        if (!existing)
          throw new NotFoundException(`Annotation ${id} not found`);

        const attachment = await this.attachmentsService.assertAttachmentExists(
          existing.attachmentId,
          userId,
          tx,
          projectId,
        );
        const effectiveProjectId =
          projectId || attachment?.item?.projectId || undefined;
        const eventScope = { userId, projectId: effectiveProjectId };

        this.assertCanModifyAnnotation(userId, existing);

        const normalizedData = this.normalizer.normalizeUpdateData(data);
        const updated = await this.annotationsRepo.update(
          id,
          expectedVersion,
          normalizedData,
          tx,
          existing,
        );

        await helpers.appendChange(eventScope, {
          entityType: 'Annotation',
          entityId: updated.id,
          action: 'update',
          version: updated.version,
          data: updated,
        });

        await helpers.publishOutbox(
          eventScope,
          updated.id,
          'library.annotation.updated',
          updated,
        );

        return updated;
      },
    );
  }

  async deleteAnnotation(
    userId: string,
    id: string,
    expectedVersion?: number,
    projectId?: string,
  ) {
    return this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const existing = await this.annotationsRepo.findById(id, tx);
        if (!existing)
          throw new NotFoundException(`Annotation ${id} not found`);

        const attachment = await this.attachmentsService.assertAttachmentExists(
          existing.attachmentId,
          userId,
          tx,
          projectId,
        );
        const effectiveProjectId =
          projectId || attachment?.item?.projectId || undefined;
        const eventScope = { userId, projectId: effectiveProjectId };

        this.assertCanModifyAnnotation(userId, existing);

        const deleted = await this.annotationsRepo.softDelete(
          id,
          expectedVersion,
          tx,
          existing,
        );

        if (deleted) {
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
              deletedAt: new Date(),
            },
          );
        }

        return deleted;
      },
    );
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

    return this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const attachment = await this.attachmentsService.assertAttachmentExists(
          attachmentId,
          userId,
          tx,
          projectId,
        );
        const effectiveProjectId =
          projectId || attachment?.item?.projectId || undefined;
        const eventScope = { userId, projectId: effectiveProjectId };

        const result = await this.annotationsRepo.batchUpsert(
          attachmentId,
          userId,
          data.upserts,
          data.deletes,
          tx,
        );

        const changes: Array<{
          entityType: string;
          entityId: string;
          action: 'create' | 'update';
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
  }

  // Auth helpers

  private assertCanModifyAnnotation(
    userId: string,
    annotation: { authorId?: string | null },
  ) {
    if (annotation.authorId && annotation.authorId !== userId) {
      throw new ForbiddenException(
        'Only the annotation author can modify or delete this annotation',
      );
    }
  }
}
