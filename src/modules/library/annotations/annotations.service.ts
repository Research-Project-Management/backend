import { Injectable, Logger } from '@nestjs/common';
import {
  AnnotationsRepository,
  CreateAnnotationData,
  UpdateAnnotationData,
} from './annotations.repository';
import { LibraryTransactionService } from '../sync/library-transaction.service';

@Injectable()
export class AnnotationsService {
  private readonly logger = new Logger(AnnotationsService.name);

  constructor(
    private readonly annotationsRepo: AnnotationsRepository,
    private readonly libraryTx: LibraryTransactionService,
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
}
