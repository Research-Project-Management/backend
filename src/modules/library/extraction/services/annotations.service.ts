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

        for (const annotation of result.created) {
          await helpers.appendChange(eventScope, {
            entityType: 'Annotation',
            entityId: annotation.id,
            action: 'create',
            version: annotation.version,
          });
          await helpers.publishOutbox(
            eventScope,
            annotation.id,
            'library.annotation.created',
            annotation,
          );
        }

        for (const annotation of result.updated) {
          await helpers.appendChange(eventScope, {
            entityType: 'Annotation',
            entityId: annotation.id,
            action: 'update',
            version: annotation.version,
          });
          await helpers.publishOutbox(
            eventScope,
            annotation.id,
            'library.annotation.updated',
            annotation,
          );
        }

        for (const id of result.deleted) {
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
