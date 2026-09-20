import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnnotationsRepository } from '../../infrastructure/repositories/annotations.repository';
import {
  CreateAnnotationData,
  UpdateAnnotationData,
  BatchAnnotationsData,
  BatchAnnotationsResult,
} from '../../domain/types/annotations.types';
import { AnnotationNormalizer } from '../normalizers/annotation.normalizer';
import {
  TransactionService,
  TransactionHelpers,
} from '../../../shared-kernel/outbox/transaction.service';
import { AttachmentsService } from './attachments.service';
import type {
  UpsertSyncAnnotationCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../../../shared-kernel/core/types/entity-commands.types';
import { AnnotationType } from '@prisma/client';
import { buildAnnotationSortIndex } from '../utils/sort-index.util';

@Injectable()
export class AnnotationsService {
  private readonly logger = new Logger(AnnotationsService.name);

  constructor(
    private readonly annotationsRepo: AnnotationsRepository,
    private readonly libraryTx: TransactionService,
    private readonly attachmentsService: AttachmentsService,
    @Optional()
    private readonly normalizer: AnnotationNormalizer = new AnnotationNormalizer(),
  ) {}

  // ─── Queries ───────────────────────────────────────────────────────────────

  async getAnnotationsByAttachment(
    userId: string,
    attachmentId: string,
    pageIndex?: number,
    type?: AnnotationType,
  ) {
    await this.attachmentsService.assertAttachmentExists(attachmentId, userId);
    return this.annotationsRepo.findByAttachment(attachmentId, pageIndex, type);
  }

  async getAnnotation(userId: string, id: string) {
    const annotation = await this.annotationsRepo.findById(id);
    if (!annotation) return null;
    await this.attachmentsService.assertAttachmentExists(
      annotation.attachmentId,
      userId,
    );
    return annotation;
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  async createAnnotation(userId: string, data: CreateAnnotationData) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const attachment = await this.attachmentsService.assertAttachmentExists(
        data.attachmentId,
        userId,
        tx,
      );
      const effectiveProjectId = attachment?.item?.projectId || undefined;
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
    });
  }

  async updateAnnotation(
    userId: string,
    id: string,
    expectedVersion: number,
    data: UpdateAnnotationData,
  ) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const existing = await this.annotationsRepo.findById(id, tx);
      if (!existing) throw new NotFoundException(`Annotation ${id} not found`);

      const attachment = await this.attachmentsService.assertAttachmentExists(
        existing.attachmentId,
        userId,
        tx,
      );
      const effectiveProjectId = attachment?.item?.projectId || undefined;
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
    });
  }

  async deleteAnnotation(userId: string, id: string, expectedVersion?: number) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const existing = await this.annotationsRepo.findById(id, tx);
      if (!existing) throw new NotFoundException(`Annotation ${id} not found`);

      const attachment = await this.attachmentsService.assertAttachmentExists(
        existing.attachmentId,
        userId,
        tx,
      );
      const effectiveProjectId = attachment?.item?.projectId || undefined;
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
    });
  }

  // ─── Batch ─────────────────────────────────────────────────────────────────

  async batchUpsertAnnotations(
    userId: string,
    attachmentId: string,
    data: BatchAnnotationsData,
  ): Promise<BatchAnnotationsResult> {
    if (data.upserts.length === 0 && data.deletes.length === 0) {
      return { created: [], updated: [], deleted: [] };
    }

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const attachment = await this.attachmentsService.assertAttachmentExists(
        attachmentId,
        userId,
        tx,
      );
      const effectiveProjectId = attachment?.item?.projectId || undefined;
      const eventScope = { userId, projectId: effectiveProjectId };

      const result = await this.annotationsRepo.batchUpsert(
        attachmentId,
        userId,
        data.upserts,
        data.deletes,
        tx,
      );

      // Outbox events for created
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

      // Outbox events for updated
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

      // Tombstones for deleted
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
    });
  }

  // ─── Sync adapters ─────────────────────────────────────────────────────────

  async upsertFromSync(
    command: UpsertSyncAnnotationCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    const userId = command.userId;
    if (command.existingId) {
      const existing = await tx.annotation.findUnique({
        where: { id: command.existingId },
      });

      if (!existing) {
        throw new NotFoundException(
          `Annotation ${command.existingId} not found`,
        );
      }

      const attachment = await this.attachmentsService.assertAttachmentExists(
        existing.attachmentId,
        userId,
        tx,
      );
      const effectiveProjectId =
        command.projectId || attachment?.item?.projectId || undefined;
      const syncScope = { userId, projectId: effectiveProjectId };

      const updated = await tx.annotation.update({
        where: { id: command.existingId },
        data: {
          quoteText: this.normalizer.normalizeQuote(command.quoteText),
          comment: this.normalizer.normalizeComment(command.comment),
          color: this.normalizer.normalizeColor(command.color),
          pageIndex: command.pageIndex,
          version: { increment: 1 },
        },
      });

      await helpers.appendChange(syncScope, {
        entityType: 'Annotation',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
      });

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      if (!command.attachmentId) {
        throw new NotFoundException(
          `Parent attachment ID required for annotation on page ${command.pageIndex}`,
        );
      }

      const attachment = await this.attachmentsService.assertAttachmentExists(
        command.attachmentId,
        userId,
        tx,
      );
      const effectiveProjectId =
        command.projectId || attachment?.item?.projectId || undefined;
      const syncScope = { userId, projectId: effectiveProjectId };

      const created = await tx.annotation.create({
        data: {
          attachmentId: command.attachmentId,
          authorId: userId,
          pageIndex: command.pageIndex,
          annotationSortIndex: buildAnnotationSortIndex(command.pageIndex),
          quoteText: this.normalizer.normalizeQuote(command.quoteText),
          comment: this.normalizer.normalizeComment(command.comment),
          color: this.normalizer.normalizeColor(command.color),
          type: this.normalizer.parseType(command.type),
          version: 1,
        },
      });

      await helpers.appendChange(syncScope, {
        entityType: 'Annotation',
        entityId: created.id,
        action: 'create',
        version: 1,
      });

      await helpers.publishOutbox(
        syncScope,
        created.id,
        'library.annotation.created',
        { annotationId: created.id },
      );

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const userId = command.userId || 'system';
    const { entityId } = command;
    const existing = await tx.annotation.findUnique({
      where: { id: entityId },
    });
    if (!existing) return;

    let effectiveProjectId = command.projectId || (command as any).projectId;
    try {
      const attachment = await this.attachmentsService.assertAttachmentExists(
        existing.attachmentId,
        userId !== 'system' ? userId : undefined,
        tx,
      );
      effectiveProjectId =
        effectiveProjectId || attachment?.item?.projectId || undefined;
    } catch {
      // Attachment or item may be deleted or inaccessible during cascade sync
    }
    const syncScope = { userId: command.userId, projectId: effectiveProjectId };

    await tx.annotation.update({
      where: { id: entityId },
      data: { deletedAt: new Date() },
    });

    await helpers.appendChange(syncScope, {
      entityType: 'Annotation',
      entityId,
      action: 'delete',
      version: existing.version + 1,
    });
    await helpers.recordTombstone(syncScope, {
      entityType: 'Annotation',
      entityId,
      deletedById: command.userId || undefined,
    });
  }

  // ─── Auth helpers ──────────────────────────────────────────────────────────

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
