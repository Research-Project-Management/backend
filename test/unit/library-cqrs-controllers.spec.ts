import { AttachmentsController } from '../../src/modules/library/reader/presentation/attachments.controller';
import { IngestionController } from '../../src/modules/library/ingestion/presentation/ingestion.controller';
import { NotesController } from '../../src/modules/library/reader/presentation/notes.controller';
import { AnnotationsController } from '../../src/modules/library/reader/presentation/annotations.controller';

describe('Library CQRS Controllers Specification (Hexagonal Driver Adapters)', () => {
  describe('AttachmentsController (Reader CQRS UseCases)', () => {
    let controller: AttachmentsController;
    let mockCreateAttachmentUseCase: { execute: jest.Mock };
    let mockGetAttachmentUseCase: { execute: jest.Mock };
    let mockGetItemAttachmentsUseCase: { execute: jest.Mock };
    let mockDeleteAttachmentUseCase: { execute: jest.Mock };
    let mockAddRevisionUseCase: { execute: jest.Mock };
    let mockSetPrimaryAttachmentUseCase: { execute: jest.Mock };
    let mockRenameAttachmentUseCase: { execute: jest.Mock };
    let mockBatchRenameAttachmentsUseCase: { execute: jest.Mock };
    let mockGetAttachmentRevisionsUseCase: { execute: jest.Mock };
    let mockGetThumbnailUseCase: { execute: jest.Mock };
    let mockWebSnapshotService: { captureAndAttach: jest.Mock };

    beforeEach(() => {
      mockCreateAttachmentUseCase = {
        execute: jest.fn().mockResolvedValue({ id: 'att-1', filename: 'thesis.pdf' }),
      };
      mockGetAttachmentUseCase = {
        execute: jest.fn().mockResolvedValue({ attachment: { id: 'att-1', filename: 'thesis.pdf' } }),
      };
      mockGetItemAttachmentsUseCase = {
        execute: jest.fn().mockResolvedValue({ attachments: [{ id: 'att-1' }], total: 1 }),
      };
      mockDeleteAttachmentUseCase = {
        execute: jest.fn().mockResolvedValue({ success: true }),
      };
      mockAddRevisionUseCase = {
        execute: jest.fn().mockResolvedValue({ id: 'att-1', version: 2 }),
      };
      mockSetPrimaryAttachmentUseCase = {
        execute: jest.fn().mockResolvedValue({ success: true }),
      };
      mockRenameAttachmentUseCase = {
        execute: jest.fn().mockResolvedValue({ oldFilename: 'old.pdf', newFilename: 'new.pdf' }),
      };
      mockBatchRenameAttachmentsUseCase = {
        execute: jest.fn().mockResolvedValue({ renamedCount: 1, results: [] }),
      };
      mockGetAttachmentRevisionsUseCase = {
        execute: jest.fn().mockResolvedValue([{ revisionNumber: 1 }]),
      };
      mockGetThumbnailUseCase = {
        execute: jest.fn().mockResolvedValue({ buffer: Buffer.from('WEBP'), mimeType: 'image/webp' }),
      };
      mockWebSnapshotService = {
        captureAndAttach: jest.fn().mockResolvedValue({ success: true }),
      };

      controller = new AttachmentsController(
        mockCreateAttachmentUseCase as any,
        mockGetAttachmentUseCase as any,
        mockGetItemAttachmentsUseCase as any,
        mockDeleteAttachmentUseCase as any,
        mockAddRevisionUseCase as any,
        mockSetPrimaryAttachmentUseCase as any,
        mockRenameAttachmentUseCase as any,
        mockBatchRenameAttachmentsUseCase as any,
        mockGetAttachmentRevisionsUseCase as any,
        mockGetThumbnailUseCase as any,
        mockWebSnapshotService as any,
      );
    });

    it('should create an attachment by delegating to CreateAttachmentUseCase', async () => {
      const dto: any = { filename: 'thesis.pdf', url: 'https://storage/thesis.pdf' };
      const res = await controller.createAttachment('user-1', 'item-1', dto, undefined, 'proj-1');

      expect(mockCreateAttachmentUseCase.execute).toHaveBeenCalledWith(
        { ...dto, userId: 'user-1', itemId: 'item-1' },
        'proj-1',
      );
      expect(res).toEqual({ id: 'att-1', filename: 'thesis.pdf' });
    });

    it('should retrieve item attachments by delegating to GetItemAttachmentsUseCase', async () => {
      const res = await controller.getItemAttachments('user-1', 'item-1', undefined, 'proj-1');

      expect(mockGetItemAttachmentsUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        itemId: 'item-1',
        projectId: 'proj-1',
      });
      expect(res).toEqual({ attachments: [{ id: 'att-1' }], total: 1 });
    });

    it('should delete attachment by delegating to DeleteAttachmentUseCase', async () => {
      const res = await controller.deleteAttachment('user-1', 'att-1', undefined, 'proj-1');

      expect(mockDeleteAttachmentUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        attachmentId: 'att-1',
        projectId: 'proj-1',
      });
      expect(res).toEqual({ success: true });
    });

    it('should add revision by delegating to AddAttachmentRevisionUseCase', async () => {
      const dto: any = { url: 'https://storage/v2.pdf', sizeBytes: 2048 };
      const res = await controller.addRevision('user-1', 'att-1', dto, undefined, 'proj-1');

      expect(mockAddRevisionUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        attachmentId: 'att-1',
        input: dto,
        projectId: 'proj-1',
      });
      expect(res).toEqual({ id: 'att-1', version: 2 });
    });

    it('should set primary attachment by delegating to SetPrimaryAttachmentUseCase', async () => {
      const res = await controller.setPrimaryAttachment('user-1', 'att-1', 'item-1', undefined, 'proj-1');

      expect(mockSetPrimaryAttachmentUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        itemId: 'item-1',
        attachmentId: 'att-1',
        projectId: 'proj-1',
      });
      expect(res).toEqual({ success: true });
    });

    it('should rename attachment by delegating to RenameAttachmentUseCase', async () => {
      const validProjId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const dto: any = { filename: 'renamed.pdf' };
      const res = await controller.renameAttachment('user-1', 'att-1', dto, undefined, validProjId);

      expect(mockRenameAttachmentUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        attachmentId: 'att-1',
        dto,
        projectId: validProjId,
      });
      expect(res).toEqual({ oldFilename: 'old.pdf', newFilename: 'new.pdf' });
    });

    it('should batch rename attachments by delegating to BatchRenameAttachmentsUseCase', async () => {
      const validProjId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const dto: any = { itemIds: ['item-1'] };
      const res = await controller.batchRenameAttachments('user-1', dto, undefined, validProjId);

      expect(mockBatchRenameAttachmentsUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        dto,
        projectId: validProjId,
      });
      expect(res).toEqual({ renamedCount: 1, results: [] });
    });

    it('should stream thumbnail by delegating to GetAttachmentThumbnailUseCase', async () => {
      const mockReply: any = {
        header: jest.fn(),
        send: jest.fn().mockImplementation((buf) => buf),
      };

      await controller.getAttachmentThumbnail('user-1', 'att-1', mockReply, undefined, 'proj-1');

      expect(mockGetThumbnailUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        attachmentId: 'att-1',
        projectId: 'proj-1',
      });
      expect(mockReply.header).toHaveBeenCalledWith('Content-Type', 'image/webp');
      expect(mockReply.send).toHaveBeenCalled();
    });
  });

  describe('IngestionController (Ingestion CQRS UseCases)', () => {
    let controller: IngestionController;
    let mockSubmitIngestionUseCase: { execute: jest.Mock };
    let mockGetIngestionStatusUseCase: { execute: jest.Mock };
    let mockGetIngestionProgressUseCase: { execute: jest.Mock };
    let mockRetryIngestionRunUseCase: { execute: jest.Mock };
    let mockCaptureUrlUseCase: { execute: jest.Mock };
    let mockConfirmCapturedUrlUseCase: { execute: jest.Mock };
    let mockUnifiedIngestUseCase: { execute: jest.Mock };

    beforeEach(() => {
      mockSubmitIngestionUseCase = {
        execute: jest.fn().mockResolvedValue({ runId: 'run-1', status: 'ACCEPTED' }),
      };
      mockGetIngestionStatusUseCase = {
        execute: jest.fn().mockResolvedValue({ runId: 'run-1', status: 'COMPLETED' }),
      };
      mockGetIngestionProgressUseCase = {
        execute: jest.fn().mockResolvedValue({ runId: 'run-1', stage: 'EXTRACTING', percent: 60 }),
      };
      mockRetryIngestionRunUseCase = {
        execute: jest.fn().mockResolvedValue({ runId: 'run-2', status: 'RETRYING' }),
      };
      mockCaptureUrlUseCase = {
        execute: jest.fn().mockResolvedValue({ previewToken: 'tok-123' }),
      };
      mockConfirmCapturedUrlUseCase = {
        execute: jest.fn().mockResolvedValue({ itemId: 'item-captured-1' }),
      };
      mockUnifiedIngestUseCase = {
        execute: jest.fn().mockResolvedValue({ success: true }),
      };

      controller = new IngestionController(
        mockSubmitIngestionUseCase as any,
        mockGetIngestionStatusUseCase as any,
        mockGetIngestionProgressUseCase as any,
        mockRetryIngestionRunUseCase as any,
        mockCaptureUrlUseCase as any,
        mockConfirmCapturedUrlUseCase as any,
        mockUnifiedIngestUseCase as any,
      );
    });

    it('should submit identifier ingestion by delegating to SubmitIngestionUseCase', async () => {
      const dto: any = {
        kind: 'IDENTIFIER',
        identifierType: 'DOI',
        value: '10.1038/nature12373',
      };
      const res = await controller.submit('user-1', 'idem-1', dto, undefined, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');

      expect(mockSubmitIngestionUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          idempotencyKey: 'idem-1',
          projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          payload: {
            kind: 'IDENTIFIER',
            identifierType: 'DOI',
            value: '10.1038/nature12373',
          },
        }),
      );
      expect(res).toEqual({ runId: 'run-1', status: 'ACCEPTED' });
    });

    it('should get ingestion status by delegating to GetIngestionStatusUseCase', async () => {
      const validUuid = '11111111-1111-4111-8111-111111111111';
      const res = await controller.getStatus('user-1', validUuid);

      expect(mockGetIngestionStatusUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        runId: validUuid,
      });
      expect(res).toEqual({ runId: 'run-1', status: 'COMPLETED' });
    });

    it('should get ingestion progress by delegating to GetIngestionProgressUseCase', async () => {
      const validUuid = '11111111-1111-4111-8111-111111111111';
      const res = await controller.getProgress('user-1', validUuid);

      expect(mockGetIngestionProgressUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        runId: validUuid,
      });
      expect(res).toEqual({ runId: 'run-1', stage: 'EXTRACTING', percent: 60 });
    });

    it('should retry ingestion run by delegating to RetryIngestionRunUseCase', async () => {
      const res = await controller.retry('user-1', 'run-1');

      expect(mockRetryIngestionRunUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        runId: 'run-1',
      });
      expect(res).toEqual({ runId: 'run-2', status: 'RETRYING' });
    });

    it('should capture URL by delegating to CaptureUrlUseCase', async () => {
      const res = await controller.captureUrl('user-1', { url: 'https://nature.com' } as any, undefined, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');

      expect(mockCaptureUrlUseCase.execute).toHaveBeenCalledWith({
        url: 'https://nature.com',
        scope: {
          projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          userId: 'user-1',
        },
      });
      expect(res).toEqual({ previewToken: 'tok-123' });
    });

    it('should confirm captured URL by delegating to ConfirmCapturedUrlUseCase', async () => {
      const dto: any = { previewToken: 'tok-123', itemData: {} };
      const res = await controller.confirmUrl('user-1', dto, undefined, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');

      expect(mockConfirmCapturedUrlUseCase.execute).toHaveBeenCalledWith({
        scopeId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        userId: 'user-1',
        dto,
      });
      expect(res).toEqual({ itemId: 'item-captured-1' });
    });

    it('should ingest unified command by delegating to UnifiedIngestUseCase', async () => {
      const dto: any = { source: 'doi', doi: '10.1038/nature12373' };
      const res = await controller.ingestUnified('user-1', 'idem-2', dto, undefined, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');

      expect(mockUnifiedIngestUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'doi',
          doi: '10.1038/nature12373',
          userId: 'user-1',
          idempotencyKey: 'idem-2',
          projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        }),
      );
      expect(res).toEqual({ success: true });
    });
  });

  describe('NotesController (Reader CQRS UseCases)', () => {
    let controller: NotesController;
    let mockCreateNoteUseCase: { execute: jest.Mock };
    let mockGetNoteUseCase: { execute: jest.Mock };
    let mockListNotesUseCase: { execute: jest.Mock };
    let mockUpdateNoteUseCase: { execute: jest.Mock };
    let mockDeleteNoteUseCase: { execute: jest.Mock };
    let mockExtractNotesUseCase: { execute: jest.Mock };

    beforeEach(() => {
      mockCreateNoteUseCase = {
        execute: jest.fn().mockResolvedValue({ id: 'note-1', title: 'Note 1' }),
      };
      mockGetNoteUseCase = {
        execute: jest.fn().mockResolvedValue({ id: 'note-1', title: 'Note 1' }),
      };
      mockListNotesUseCase = {
        execute: jest.fn().mockResolvedValue([{ id: 'note-1', title: 'Note 1' }]),
      };
      mockUpdateNoteUseCase = {
        execute: jest.fn().mockResolvedValue({ id: 'note-1', version: 2 }),
      };
      mockDeleteNoteUseCase = {
        execute: jest.fn().mockResolvedValue(true),
      };
      mockExtractNotesUseCase = {
        execute: jest.fn().mockResolvedValue({ success: true, totalExtracted: 2 }),
      };

      controller = new NotesController(
        mockCreateNoteUseCase as any,
        mockGetNoteUseCase as any,
        mockListNotesUseCase as any,
        mockUpdateNoteUseCase as any,
        mockDeleteNoteUseCase as any,
        mockExtractNotesUseCase as any,
      );
    });

    it('should list notes by delegating to ListNotesUseCase', async () => {
      const validProjId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const res = await controller.listNotes('user-1', 'item-1', undefined, validProjId);
      expect(mockListNotesUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        itemId: 'item-1',
        projectId: validProjId,
      });
      expect(res).toEqual([{ id: 'note-1', title: 'Note 1' }]);
    });

    it('should get note by delegating to GetNoteUseCase', async () => {
      const res = await controller.getNote('user-1', 'note-1', undefined, 'proj-1');
      expect(mockGetNoteUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        id: 'note-1',
        projectId: 'proj-1',
      });
      expect(res).toEqual({ id: 'note-1', title: 'Note 1' });
    });

    it('should create note by delegating to CreateNoteUseCase', async () => {
      const dto: any = { title: 'My Note', contentMd: 'Content' };
      const res = await controller.createNote('user-1', dto, undefined, 'proj-1');
      expect(mockCreateNoteUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        data: expect.objectContaining({
          title: 'My Note',
          contentMd: 'Content',
          projectId: 'proj-1',
          createdById: 'user-1',
        }),
        projectId: 'proj-1',
      });
      expect(res).toEqual({ id: 'note-1', title: 'Note 1' });
    });

    it('should extract notes from annotations by delegating to ExtractNotesFromAnnotationsUseCase', async () => {
      const res = await controller.extractNotesFromAnnotations('user-1', 'item-1');
      expect(mockExtractNotesUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        itemId: 'item-1',
      });
      expect(res).toEqual({ success: true, totalExtracted: 2 });
    });

    it('should update note by delegating to UpdateNoteUseCase', async () => {
      const dto: any = { title: 'Updated', expectedVersion: 1 };
      const res = await controller.updateNote('user-1', 'note-1', undefined, dto, undefined, 'proj-1');
      expect(mockUpdateNoteUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        id: 'note-1',
        expectedVersion: 1,
        data: { title: 'Updated' },
        projectId: 'proj-1',
      });
      expect(res).toEqual({ id: 'note-1', version: 2 });
    });

    it('should delete note by delegating to DeleteNoteUseCase', async () => {
      const res = await controller.deleteNote('user-1', 'note-1', '1', undefined, undefined, 'proj-1');
      expect(mockDeleteNoteUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        id: 'note-1',
        expectedVersion: 1,
        projectId: 'proj-1',
      });
      expect(res).toEqual({ deleted: true, id: 'note-1' });
    });

    it('should support legacy constructor with NotesService fallback', async () => {
      const mockLegacyService = {
        listNotes: jest.fn().mockResolvedValue([{ id: 'legacy-note' }]),
        getNote: jest.fn().mockResolvedValue({ id: 'legacy-note' }),
      };
      const legacyController = new NotesController(mockLegacyService as any);
      const res = await legacyController.listNotes('user-1');
      expect(mockLegacyService.listNotes).toHaveBeenCalledWith('user-1', undefined, undefined);
      expect(res).toEqual([{ id: 'legacy-note' }]);
    });
  });

  describe('AnnotationsController (Reader CQRS UseCases)', () => {
    let controller: AnnotationsController;
    let mockCreateAnnotationUseCase: { execute: jest.Mock };
    let mockListAnnotationsUseCase: { execute: jest.Mock };
    let mockUpdateAnnotationUseCase: { execute: jest.Mock };
    let mockDeleteAnnotationUseCase: { execute: jest.Mock };
    let mockBatchUpsertAnnotationsUseCase: { execute: jest.Mock };
    let mockPdfImporterService: { importFromAttachment: jest.Mock };

    beforeEach(() => {
      mockCreateAnnotationUseCase = {
        execute: jest.fn().mockResolvedValue({ id: 'annot-1', color: '#ffeb3b' }),
      };
      mockListAnnotationsUseCase = {
        execute: jest.fn().mockResolvedValue([{ id: 'annot-1' }]),
      };
      mockUpdateAnnotationUseCase = {
        execute: jest.fn().mockResolvedValue({ id: 'annot-1', color: '#ff0000' }),
      };
      mockDeleteAnnotationUseCase = {
        execute: jest.fn().mockResolvedValue(true),
      };
      mockBatchUpsertAnnotationsUseCase = {
        execute: jest.fn().mockResolvedValue({ created: [], updated: [], deleted: [] }),
      };
      mockPdfImporterService = {
        importFromAttachment: jest.fn().mockResolvedValue({ imported: 3 }),
      };

      controller = new AnnotationsController(
        mockCreateAnnotationUseCase as any,
        mockListAnnotationsUseCase as any,
        mockUpdateAnnotationUseCase as any,
        mockDeleteAnnotationUseCase as any,
        mockBatchUpsertAnnotationsUseCase as any,
        mockPdfImporterService as any,
      );
    });

    it('should list annotations by delegating to ListAnnotationsUseCase', async () => {
      const res = await controller.listAnnotations('user-1', 'att-1', '0', 'highlight' as any);
      expect(mockListAnnotationsUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        attachmentId: 'att-1',
        pageIndex: 0,
        type: 'highlight',
      });
      expect(res).toEqual([{ id: 'annot-1' }]);
    });

    it('should create annotation by delegating to CreateAnnotationUseCase', async () => {
      const dto: any = { type: 'highlight', pageIndex: 1, color: '#ffeb3b' };
      const res = await controller.createAnnotation('user-1', 'att-1', dto);
      expect(mockCreateAnnotationUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        data: expect.objectContaining({
          attachmentId: 'att-1',
          type: 'highlight',
          pageIndex: 1,
          color: '#ffeb3b',
          authorId: 'user-1',
        }),
      });
      expect(res).toEqual({ id: 'annot-1', color: '#ffeb3b' });
    });

    it('should update annotation by delegating to UpdateAnnotationUseCase', async () => {
      const dto: any = { expectedVersion: 1, color: '#ff0000' };
      const res = await controller.updateAnnotation('user-1', 'att-1', 'annot-1', undefined, dto);
      expect(mockUpdateAnnotationUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        id: 'annot-1',
        expectedVersion: 1,
        data: { color: '#ff0000' },
      });
      expect(res).toEqual({ id: 'annot-1', color: '#ff0000' });
    });

    it('should delete annotation by delegating to DeleteAnnotationUseCase', async () => {
      const res = await controller.deleteAnnotation('user-1', 'att-1', 'annot-1', '1');
      expect(mockDeleteAnnotationUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        id: 'annot-1',
        expectedVersion: 1,
      });
      expect(res).toEqual({ id: 'annot-1', deleted: true });
    });

    it('should batch upsert annotations by delegating to BatchUpsertAnnotationsUseCase', async () => {
      const dto: any = { upserts: [{ pageIndex: 1 }], deletes: ['annot-old'] };
      const res = await controller.batchUpsertAnnotations('user-1', 'att-1', dto);
      expect(mockBatchUpsertAnnotationsUseCase.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        attachmentId: 'att-1',
        data: { upserts: dto.upserts, deletes: dto.deletes },
      });
      expect(res).toEqual({ created: [], updated: [], deleted: [] });
    });

    it('should import external annotations by delegating to PdfAnnotationImporterService', async () => {
      const res = await controller.importExternalAnnotations('user-1', 'att-1');
      expect(mockPdfImporterService.importFromAttachment).toHaveBeenCalledWith('user-1', 'att-1');
      expect(res).toEqual({ imported: 3 });
    });

    it('should support legacy constructor with AnnotationsService fallback', async () => {
      const mockLegacyService = {
        getAnnotationsByAttachment: jest.fn().mockResolvedValue([{ id: 'legacy-annot' }]),
      };
      const legacyController = new AnnotationsController(
        mockLegacyService as any,
        mockPdfImporterService as any,
      );
      const res = await legacyController.listAnnotations('user-1', 'att-1');
      expect(mockLegacyService.getAnnotationsByAttachment).toHaveBeenCalledWith(
        'user-1',
        'att-1',
        undefined,
        undefined,
      );
      expect(res).toEqual([{ id: 'legacy-annot' }]);
    });
  });
});

