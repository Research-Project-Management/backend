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
import { AttachmentsService } from '../attachments/attachments.service';
import { PrismaService } from '@/core/database/prisma.service';
import type {
  UpsertSyncAnnotationCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../common/types/sync.types';

@Injectable()
export class AnnotationsService {
  private readonly logger = new Logger(AnnotationsService.name);

  constructor(
    private readonly annotationsRepo: AnnotationsRepository,
    private readonly libraryTx: TransactionService,
    private readonly attachmentsService: AttachmentsService,
    private readonly prisma: PrismaService,
  ) {}

  async getAnnotationsByAttachment(
    workspaceId: string,
    attachmentId: string,
    pageIndex?: number,
  ) {
    await this.attachmentsService.assertAttachmentInWorkspace(
      attachmentId,
      workspaceId,
    );
    return this.annotationsRepo.findByAttachment(attachmentId, pageIndex);
  }

  async getAnnotation(workspaceId: string, id: string) {
    const annotation = await this.annotationsRepo.findById(id);
    if (!annotation) return null;
    await this.attachmentsService.assertAttachmentInWorkspace(
      annotation.attachmentId,
      workspaceId,
    );
    return annotation;
  }

  async createAnnotation(workspaceId: string, data: CreateAnnotationData) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      await this.attachmentsService.assertAttachmentInWorkspace(
        data.attachmentId,
        workspaceId,
        tx,
      );
      const annotation = await this.annotationsRepo.create(data, tx);

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

  private async assertCanModifyAnnotation(
    workspaceId: string,
    annotation: { authorId?: string | null },
    userId?: string,
  ) {
    if (!userId) {
      throw new ForbiddenException('User is not authenticated');
    }
    // Author can always edit/delete their own annotation
    if (annotation.authorId && annotation.authorId === userId) {
      return;
    }
    // Otherwise user must have admin or owner role in the workspace
    const member = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId },
      },
    });
    if (member?.role === 'owner' || member?.role === 'admin') {
      return;
    }
    throw new ForbiddenException(
      'Only the annotation author or workspace admin/owner can modify or delete this annotation',
    );
  }

  async updateAnnotation(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    data: UpdateAnnotationData,
    userId?: string,
  ) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const existing = await this.annotationsRepo.findById(id, tx);
      if (!existing) {
        throw new NotFoundException(`Annotation ${id} not found`);
      }
      await this.attachmentsService.assertAttachmentInWorkspace(
        existing.attachmentId,
        workspaceId,
        tx,
      );

      if (userId) {
        await this.assertCanModifyAnnotation(workspaceId, existing, userId);
      }

      const updated = await this.annotationsRepo.update(
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
    userId?: string,
  ) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const existing = await this.annotationsRepo.findById(id, tx);
      if (!existing) {
        throw new NotFoundException(`Annotation ${id} not found`);
      }
      await this.attachmentsService.assertAttachmentInWorkspace(
        existing.attachmentId,
        workspaceId,
        tx,
      );

      if (userId) {
        await this.assertCanModifyAnnotation(workspaceId, existing, userId);
      }

      const deleted = await this.annotationsRepo.softDelete(
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
      });

      if (!existing) {
        throw new NotFoundException(
          `Annotation ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      await this.attachmentsService.assertAttachmentInWorkspace(
        existing.attachmentId,
        command.workspaceId,
        tx,
      );

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

      await this.attachmentsService.assertAttachmentInWorkspace(
        command.attachmentId,
        command.workspaceId,
        tx,
      );

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
    });
    if (!existing) return;

    await this.attachmentsService.assertAttachmentInWorkspace(
      existing.attachmentId,
      workspaceId,
      tx,
    );

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
