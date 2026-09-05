import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AnnotationsRepository,
  CreateAnnotationData,
  UpdateAnnotationData,
} from './annotations.repository';
import {
  TransactionService,
  TransactionHelpers,
} from '../outbox/transaction.service';
import type {
  UpsertSyncAnnotationCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../sync/ports/sync.port';

@Injectable()
export class AnnotationsService {
  private readonly logger = new Logger(AnnotationsService.name);

  constructor(
    private readonly annotationsRepo: AnnotationsRepository,
    private readonly libraryTx: TransactionService,
  ) {}

  async getAnnotationsByAttachment(
    workspaceId: string,
    attachmentId: string,
    pageIndex?: number,
  ) {
    return this.annotationsRepo.findByAttachment(
      workspaceId,
      attachmentId,
      pageIndex,
    );
  }

  async getAnnotation(workspaceId: string, id: string) {
    return this.annotationsRepo.findById(workspaceId, id);
  }

  async createAnnotation(workspaceId: string, data: CreateAnnotationData) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const annotation = await this.annotationsRepo.create(
        workspaceId,
        data,
        tx,
      );

      await helpers.appendChange(workspaceId, {
        entityType: 'Annotation',
        entityId: annotation.id,
        action: 'create',
        version: annotation.version,
        data: annotation,
      });

      await helpers.publishOutbox(
        workspaceId,
        annotation.id,
        'library.annotation.created',
        annotation,
      );

      return annotation;
    });
  }

  async updateAnnotation(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    data: UpdateAnnotationData,
  ) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const updated = await this.annotationsRepo.update(
        workspaceId,
        id,
        expectedVersion,
        data,
        tx,
      );

      await helpers.appendChange(workspaceId, {
        entityType: 'Annotation',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await helpers.publishOutbox(
        workspaceId,
        updated.id,
        'library.annotation.updated',
        updated,
      );

      return updated;
    });
  }

  async deleteAnnotation(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
  ) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const deleted = await this.annotationsRepo.softDelete(
        workspaceId,
        id,
        expectedVersion,
        tx,
      );

      if (deleted) {
        await helpers.recordTombstone(workspaceId, {
          entityType: 'Annotation',
          entityId: id,
        });

        await helpers.publishOutbox(
          workspaceId,
          id,
          'library.annotation.deleted',
          { id, deletedAt: new Date() },
        );
      }

      return deleted;
    });
  }

  /**
   * Sync protocol adapter: transactional upsert for an Annotation from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncAnnotationCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    if (command.existingId) {
      const existing = await tx.annotation.findUnique({
        where: { id: command.existingId },
        include: { attachment: { include: { catalogItem: true } } },
      });

      if (!existing) {
        throw new NotFoundException(
          `Annotation ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      if (existing.attachment.catalogItem.workspaceId !== command.workspaceId) {
        throw new ForbiddenException(
          `Annotation ${command.existingId} does not belong to workspace ${command.workspaceId}`,
        );
      }

      const updated = await tx.annotation.update({
        where: { id: command.existingId },
        data: {
          quoteText: command.quoteText,
          comment: command.comment,
          color: command.color,
          pageIndex: command.pageIndex,
          version: { increment: 1 },
        },
      });

      await helpers.appendChange(command.workspaceId, {
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

      const att = await tx.catalogAttachment.findUnique({
        where: { id: command.attachmentId },
        include: { catalogItem: true },
      });

      if (!att || att.catalogItem.workspaceId !== command.workspaceId) {
        throw new NotFoundException(
          `Attachment ${command.attachmentId} not found in workspace ${command.workspaceId}`,
        );
      }

      const created = await tx.annotation.create({
        data: {
          attachmentId: command.attachmentId,
          authorId: command.userId,
          pageIndex: command.pageIndex,
          quoteText: command.quoteText || '',
          comment: command.comment || '',
          color: command.color || '#ffd400',
          type: (command.type as any) || 'highlight',
          version: 1,
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Annotation',
        entityId: created.id,
        action: 'create',
        version: 1,
      });

      await helpers.publishOutbox(
        command.workspaceId,
        created.id,
        'library.annotation.created',
        { annotationId: created.id },
      );

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  /**
   * Sync protocol adapter: transactional soft-delete for an Annotation from an external sync batch.
   */
  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const { workspaceId, entityId } = command;
    const existing = await tx.annotation.findUnique({
      where: { id: entityId },
      include: { attachment: { include: { catalogItem: true } } },
    });
    if (!existing) return;

    if (existing.attachment.catalogItem.workspaceId !== workspaceId) {
      throw new ForbiddenException(
        `Annotation ${entityId} does not belong to workspace ${workspaceId}`,
      );
    }

    await tx.annotation.update({
      where: { id: entityId },
      data: { deletedAt: new Date() },
    });
    await helpers.appendChange(workspaceId, {
      entityType: 'Annotation',
      entityId,
      action: 'delete',
      version: existing.version + 1,
    });
  }
}
