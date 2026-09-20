import { Injectable, Optional } from '@nestjs/common';
import { AttachmentsService } from './application/services/attachments.service';
import { AnnotationsService } from './application/services/annotations.service';
import { NotesService } from './application/services/notes.service';
import {
  PdfProvider,
  ExtractedPdfDocument,
} from './infrastructure/providers/pdf.provider';
import { WebSnapshotService } from './application/services/web-snapshot.service';

export const READER_FACADE = 'READER_FACADE';
export const CONTENT_FACADE = READER_FACADE;

export interface IReaderFacade {
  getItemAttachments(userId: string, itemId: string): Promise<any>;
  getItemAttachment(
    userId: string,
    attachmentId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<any>;
  createAttachment(data: any, projectId?: string): Promise<any>;
  listNotes(
    userId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<any[]>;
  getNote(userId: string, noteId: string, projectId?: string): Promise<any>;
  createNote(userId: string, data: any): Promise<any>;
  getAnnotationsByAttachment(
    userId: string,
    attachmentId: string,
  ): Promise<any[]>;
  extractNotesFromAnnotations(userId: string, itemId: string): Promise<any>;
  extractDocumentFromBuffer(
    buffer: Buffer,
    options?: any,
  ): Promise<ExtractedPdfDocument>;
  extractMetadataFromBuffer(buffer: Buffer): any;
  captureWebSnapshot(url: string, itemId: string, userId: string): Promise<any>;
  reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: any,
  ): Promise<void>;
}

export type IContentFacade = IReaderFacade;

/**
 * Public Facade for Reader Bounded Context (Supporting Domain).
 * Encapsulates attachments, annotations, notes, and OCR behind a cohesive boundary.
 */
@Injectable()
export class ReaderFacade implements IReaderFacade {
  constructor(
    @Optional() private readonly attachmentsService?: AttachmentsService,
    @Optional() private readonly annotationsService?: AnnotationsService,
    @Optional() private readonly notesService?: NotesService,
    @Optional() private readonly pdfProvider?: PdfProvider,
    @Optional() private readonly webSnapshotService?: WebSnapshotService,
  ) {}

  async getItemAttachments(userId: string, itemId: string): Promise<any> {
    if (!this.attachmentsService) return { attachments: [], total: 0 };
    return this.attachmentsService.getItemAttachments(userId, itemId);
  }

  async getItemAttachment(
    userId: string,
    attachmentId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<any> {
    if (!this.attachmentsService) return null;
    return this.attachmentsService.getItemAttachment(
      userId,
      itemId,
      attachmentId,
      projectId,
    );
  }

  async createAttachment(data: any, projectId?: string): Promise<any> {
    if (!this.attachmentsService) return null;
    return this.attachmentsService.createAttachment(data, projectId);
  }

  async listNotes(
    userId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<any[]> {
    if (!this.notesService) return [];
    return this.notesService.listNotes(userId, itemId, projectId);
  }

  async getNote(
    userId: string,
    noteId: string,
    projectId?: string,
  ): Promise<any> {
    if (!this.notesService) return null;
    return this.notesService.getNote(userId, noteId, projectId);
  }

  async createNote(userId: string, data: any): Promise<any> {
    if (!this.notesService) return null;
    return this.notesService.createNote(userId, data);
  }

  async getAnnotationsByAttachment(
    userId: string,
    attachmentId: string,
  ): Promise<any[]> {
    if (!this.annotationsService) return [];
    return this.annotationsService.getAnnotationsByAttachment(
      userId,
      attachmentId,
    );
  }

  async extractNotesFromAnnotations(
    userId: string,
    itemId: string,
  ): Promise<any> {
    if (!this.notesService) return null;
    return this.notesService.extractNotesFromAnnotations(userId, itemId);
  }

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: any,
  ): Promise<ExtractedPdfDocument> {
    if (!this.pdfProvider) {
      throw new Error('PdfProvider is not initialized in ContentFacade');
    }
    return this.pdfProvider.extractDocumentFromBuffer(buffer, options);
  }

  extractMetadataFromBuffer(buffer: Buffer): any {
    if (!this.pdfProvider) return {};
    return this.pdfProvider.extractMetadataFromBuffer(buffer);
  }

  async captureWebSnapshot(
    url: string,
    itemId: string,
    userId: string,
  ): Promise<any> {
    if (!this.webSnapshotService) {
      throw new Error('WebSnapshotService is not initialized in ContentFacade');
    }
    return this.webSnapshotService.captureAndAttach(url, itemId, userId);
  }

  async reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: any,
  ): Promise<void> {
    if (this.attachmentsService) {
      await this.attachmentsService.reassignToItem(
        duplicateItemIds,
        primaryItemId,
        tx,
      );
    }
    if (this.notesService) {
      await this.notesService.reassignToItem(
        duplicateItemIds,
        primaryItemId,
        tx,
      );
    }
  }
}

export { ReaderFacade as ContentFacade };
