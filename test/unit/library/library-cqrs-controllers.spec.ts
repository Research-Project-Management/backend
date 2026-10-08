import { NotFoundException } from '@nestjs/common';
import { AttachmentsController } from '@/modules/library/extraction/controllers/attachments.controller';
import { IngestionController } from '@/modules/library/ingestion/controllers/ingestion.controller';
import { NotesController } from '@/modules/library/catalog/controllers/notes.controller';
import { AnnotationsController } from '@/modules/library/extraction/controllers/annotations.controller';

describe('Library CQRS Controllers Specification (Hexagonal Driver Adapters)', () => {
  describe('AttachmentsController (Reader CQRS Adapter)', () => {
    let controller: AttachmentsController;
    let mockAttachmentsService: {
      createAttachment: jest.Mock;
      getItemAttachment: jest.Mock;
      getItemAttachments: jest.Mock;
      deleteAttachment: jest.Mock;
      setPrimaryAttachment: jest.Mock;
      renameAttachment: jest.Mock;
      batchRenameAttachments: jest.Mock;
      getThumbnail: jest.Mock;
    };
    let mockWebSnapshotService: { captureAndAttach: jest.Mock };

    beforeEach(() => {
      mockAttachmentsService = {
        createAttachment: jest
          .fn()
          .mockResolvedValue({ id: 'att-1', filename: 'thesis.pdf' }),
        getItemAttachment: jest.fn().mockResolvedValue({
          attachment: { id: 'att-1', filename: 'thesis.pdf' },
        }),
        getItemAttachments: jest
          .fn()
          .mockResolvedValue({ attachments: [{ id: 'att-1' }], total: 1 }),
        deleteAttachment: jest.fn().mockResolvedValue({ success: true }),
        setPrimaryAttachment: jest.fn().mockResolvedValue({ success: true }),
        renameAttachment: jest.fn().mockResolvedValue({
          oldFilename: 'old.pdf',
          newFilename: 'new.pdf',
        }),
        batchRenameAttachments: jest
          .fn()
          .mockResolvedValue({ renamedCount: 1, results: [] }),
        getThumbnail: jest.fn().mockResolvedValue({
          buffer: Buffer.from('WEBP'),
          mimeType: 'image/webp',
        }),
      };
      mockWebSnapshotService = {
        captureAndAttach: jest.fn().mockResolvedValue({ success: true }),
      };

      controller = new AttachmentsController(
        mockAttachmentsService as any,
        mockWebSnapshotService as any,
      );
    });

    it('should create an attachment by delegating to AttachmentsService', async () => {
      const dto: any = {
        filename: 'thesis.pdf',
        url: 'https://storage/thesis.pdf',
      };
      const res = await controller.createAttachment(
        'user-1',
        'item-1',
        dto,
        undefined,
        'proj-1',
      );

      expect(mockAttachmentsService.createAttachment).toHaveBeenCalledWith(
        { ...dto, userId: 'user-1', itemId: 'item-1' },
        'proj-1',
      );
      expect(res).toEqual({ id: 'att-1', filename: 'thesis.pdf' });
    });

    it('should retrieve item attachments by delegating to AttachmentsService', async () => {
      const res = await controller.getItemAttachments(
        'user-1',
        'item-1',
        undefined,
        'proj-1',
      );

      expect(mockAttachmentsService.getItemAttachments).toHaveBeenCalledWith(
        'user-1',
        'item-1',
        'proj-1',
      );
      expect(res).toEqual({ attachments: [{ id: 'att-1' }], total: 1 });
    });

    it('should delete attachment by delegating to AttachmentsService', async () => {
      const res = await controller.deleteAttachment(
        'user-1',
        'att-1',
        undefined,
        'proj-1',
      );

      expect(mockAttachmentsService.deleteAttachment).toHaveBeenCalledWith(
        'user-1',
        'att-1',
        'proj-1',
      );
      expect(res).toEqual({ success: true });
    });

    it('should set primary attachment by delegating to AttachmentsService', async () => {
      const res = await controller.setPrimaryAttachment(
        'user-1',
        'att-1',
        'item-1',
        undefined,
        'proj-1',
      );

      expect(mockAttachmentsService.setPrimaryAttachment).toHaveBeenCalledWith(
        'user-1',
        'item-1',
        'att-1',
        'proj-1',
      );
      expect(res).toEqual({ success: true });
    });

    it('should rename attachment by delegating to AttachmentsService', async () => {
      const validProjId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const dto: any = { filename: 'renamed.pdf' };
      const res = await controller.renameAttachment(
        'user-1',
        'att-1',
        dto,
        undefined,
        validProjId,
      );

      expect(mockAttachmentsService.renameAttachment).toHaveBeenCalledWith(
        'user-1',
        'att-1',
        dto,
        validProjId,
      );
      expect(res).toEqual({ oldFilename: 'old.pdf', newFilename: 'new.pdf' });
    });

    it('should batch rename attachments by delegating to AttachmentsService', async () => {
      const validProjId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const dto: any = { itemIds: ['item-1'] };
      const res = await controller.batchRenameAttachments(
        'user-1',
        dto,
        undefined,
        validProjId,
      );

      expect(
        mockAttachmentsService.batchRenameAttachments,
      ).toHaveBeenCalledWith('user-1', dto, validProjId);
      expect(res).toEqual({ renamedCount: 1, results: [] });
    });

    it('should stream thumbnail by delegating to AttachmentsService', async () => {
      const mockReply: any = {
        header: jest.fn(),
        send: jest.fn().mockImplementation((buf) => buf),
      };

      await controller.getAttachmentThumbnail(
        'user-1',
        'att-1',
        mockReply,
        undefined,
        'proj-1',
      );

      expect(mockAttachmentsService.getThumbnail).toHaveBeenCalledWith(
        'user-1',
        'att-1',
        'proj-1',
      );
      expect(mockReply.header).toHaveBeenCalledWith(
        'Content-Type',
        'image/webp',
      );
      expect(mockReply.send).toHaveBeenCalled();
    });
  });

  describe('IngestionController (Ingestion Adapter)', () => {
    let controller: IngestionController;
    let mockIngestionService: {
      submit: jest.Mock;
      getRunStatus: jest.Mock;
      getRunProgress: jest.Mock;
      retryRun: jest.Mock;
      ingest: jest.Mock;
    };
    let mockUrlCaptureService: {
      captureUrl: jest.Mock;
      confirmCapturedUrl: jest.Mock;
    };

    beforeEach(() => {
      mockIngestionService = {
        submit: jest
          .fn()
          .mockResolvedValue({ runId: 'run-1', status: 'ACCEPTED' }),
        getRunStatus: jest
          .fn()
          .mockResolvedValue({ runId: 'run-1', status: 'COMPLETED' }),
        getRunProgress: jest.fn().mockResolvedValue({
          runId: 'run-1',
          stage: 'EXTRACTING',
          percent: 60,
        }),
        retryRun: jest
          .fn()
          .mockResolvedValue({ runId: 'run-2', status: 'RETRYING' }),
        ingest: jest.fn().mockResolvedValue({ success: true }),
      };
      mockUrlCaptureService = {
        captureUrl: jest.fn().mockResolvedValue({ previewToken: 'tok-123' }),
        confirmCapturedUrl: jest
          .fn()
          .mockResolvedValue({ itemId: 'item-captured-1' }),
      };

      controller = new IngestionController(
        mockIngestionService as any,
        mockUrlCaptureService as any,
      );
    });

    it('should submit identifier ingestion by delegating to IngestionService', async () => {
      const dto: any = {
        kind: 'IDENTIFIER',
        identifierType: 'DOI',
        value: '10.1038/nature12373',
      };
      const res = await controller.submit(
        'user-1',
        'idem-1',
        dto,
        undefined,
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      );

      expect(mockIngestionService.submit).toHaveBeenCalledWith(
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

    it('should get ingestion status by delegating to IngestionService', async () => {
      const validUuid = '11111111-1111-4111-8111-111111111111';
      const res = await controller.getStatus('user-1', validUuid);

      expect(mockIngestionService.getRunStatus).toHaveBeenCalledWith(
        'user-1',
        validUuid,
      );
      expect(res).toEqual({ runId: 'run-1', status: 'COMPLETED' });
    });

    it('should get ingestion progress by delegating to IngestionService', async () => {
      const validUuid = '11111111-1111-4111-8111-111111111111';
      const res = await controller.getProgress('user-1', validUuid);

      expect(mockIngestionService.getRunProgress).toHaveBeenCalledWith(
        'user-1',
        validUuid,
      );
      expect(res).toEqual({ runId: 'run-1', stage: 'EXTRACTING', percent: 60 });
    });

    it('should retry ingestion run by delegating to IngestionService', async () => {
      const validUuid = '11111111-1111-4111-8111-111111111111';
      const res = await controller.retry('user-1', validUuid);

      expect(mockIngestionService.retryRun).toHaveBeenCalledWith(
        'user-1',
        validUuid,
      );
      expect(res).toEqual({ runId: 'run-2', status: 'RETRYING' });
    });

    it('should capture URL by delegating to UrlCaptureService', async () => {
      const res = await controller.captureUrl(
        'user-1',
        { url: 'https://nature.com' },
        undefined,
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      );

      expect(mockUrlCaptureService.captureUrl).toHaveBeenCalledWith(
        'https://nature.com',
        {
          projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          userId: 'user-1',
        },
      );
      expect(res).toEqual({ previewToken: 'tok-123' });
    });

    it('should confirm captured URL by delegating to UrlCaptureService', async () => {
      const dto: any = { previewToken: 'tok-123', itemData: {} };
      const res = await controller.confirmUrl(
        'user-1',
        dto,
        undefined,
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      );

      expect(mockUrlCaptureService.confirmCapturedUrl).toHaveBeenCalledWith(
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        'user-1',
        dto,
      );
      expect(res).toEqual({ itemId: 'item-captured-1' });
    });

    it('should ingest unified command by delegating to IngestionService', async () => {
      const dto: any = { source: 'doi', doi: '10.1038/nature12373' };
      const res = await controller.ingestUnified(
        'user-1',
        'idem-2',
        dto,
        undefined,
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      );

      expect(mockIngestionService.ingest).toHaveBeenCalledWith(
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

  describe('NotesController (Reader Adapter)', () => {
    let controller: NotesController;
    let mockNotesService: {
      createNote: jest.Mock;
      getNote: jest.Mock;
      listNotes: jest.Mock;
      updateNote: jest.Mock;
      deleteNote: jest.Mock;
      extractNotesFromAnnotations: jest.Mock;
    };

    const sampleNoteId = '11111111-2222-4333-8444-555555555555';
    const sampleItemId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

    beforeEach(() => {
      mockNotesService = {
        createNote: jest
          .fn()
          .mockResolvedValue({ id: sampleNoteId, title: 'Note 1' }),
        getNote: jest
          .fn()
          .mockResolvedValue({ id: sampleNoteId, title: 'Note 1' }),
        listNotes: jest
          .fn()
          .mockResolvedValue([{ id: sampleNoteId, title: 'Note 1' }]),
        updateNote: jest
          .fn()
          .mockResolvedValue({ id: sampleNoteId, version: 2 }),
        deleteNote: jest.fn().mockResolvedValue({ deleted: true }),
        extractNotesFromAnnotations: jest
          .fn()
          .mockResolvedValue({ success: true, totalExtracted: 2 }),
      };

      controller = new NotesController(mockNotesService as any);
    });

    it('should list notes by delegating to NotesService', async () => {
      const validProjId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const res = await controller.listNotes(
        'user-1',
        sampleItemId,
        undefined,
        validProjId,
      );
      expect(mockNotesService.listNotes).toHaveBeenCalledWith(
        'user-1',
        sampleItemId,
        validProjId,
      );
      expect(res).toEqual([{ id: sampleNoteId, title: 'Note 1' }]);
    });

    it('should get note by delegating to NotesService', async () => {
      const res = await controller.getNote(
        'user-1',
        sampleNoteId,
        undefined,
        'proj-1',
      );
      expect(mockNotesService.getNote).toHaveBeenCalledWith(
        'user-1',
        sampleNoteId,
        'proj-1',
      );
      expect(res).toEqual({ id: sampleNoteId, title: 'Note 1' });
    });

    it('should create note by delegating to NotesService', async () => {
      const dto: any = { title: 'My Note', contentMd: 'Content' };
      const res = await controller.createNote(
        'user-1',
        dto,
        undefined,
        'proj-1',
      );
      expect(mockNotesService.createNote).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          title: 'My Note',
          contentMd: 'Content',
          projectId: 'proj-1',
          createdById: 'user-1',
        }),
      );
      expect(res).toEqual({ id: sampleNoteId, title: 'Note 1' });
    });

    it('should extract notes from annotations by delegating to NotesService', async () => {
      const res = await controller.extractNotesFromAnnotations(
        'user-1',
        sampleItemId,
      );
      expect(mockNotesService.extractNotesFromAnnotations).toHaveBeenCalledWith(
        'user-1',
        sampleItemId,
        undefined,
      );
      expect(res).toEqual({ success: true, totalExtracted: 2 });
    });

    it('should update note by delegating to NotesService', async () => {
      const dto: any = { title: 'Updated', expectedVersion: 1 };
      const res = await controller.updateNote('user-1', sampleNoteId, dto);
      expect(mockNotesService.updateNote).toHaveBeenCalledWith(
        'user-1',
        sampleNoteId,
        dto,
      );
      expect(res).toEqual({ id: sampleNoteId, version: 2 });
    });

    it('should delete note by delegating to NotesService', async () => {
      const res = await controller.deleteNote('user-1', sampleNoteId);
      expect(mockNotesService.deleteNote).toHaveBeenCalledWith(
        'user-1',
        sampleNoteId,
      );
      expect(res).toEqual({ deleted: true });
    });

    it('should throw NotFoundException when note is not found', async () => {
      mockNotesService.getNote.mockResolvedValueOnce(null);
      await expect(controller.getNote('user-1', sampleNoteId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('AnnotationsController (Annotation Adapter)', () => {
    let controller: AnnotationsController;
    let mockAnnotationsService: {
      createAnnotation: jest.Mock;
      listAnnotations?: jest.Mock;
      getAnnotationsByAttachment?: jest.Mock;
      updateAnnotation: jest.Mock;
      deleteAnnotation: jest.Mock;
      batchUpsertAnnotations: jest.Mock;
    };
    let mockPdfAnnotationImporterService: { importFromAttachment: jest.Mock };

    beforeEach(() => {
      mockAnnotationsService = {
        createAnnotation: jest
          .fn()
          .mockResolvedValue({ id: 'annot-1', color: '#ffeb3b' }),
        getAnnotationsByAttachment: jest
          .fn()
          .mockResolvedValue([{ id: 'annot-1' }]),
        updateAnnotation: jest
          .fn()
          .mockResolvedValue({ id: 'annot-1', color: '#ff0000' }),
        deleteAnnotation: jest
          .fn()
          .mockResolvedValue({ id: 'annot-1', deleted: true }),
        batchUpsertAnnotations: jest
          .fn()
          .mockResolvedValue({ created: [], updated: [], deleted: [] }),
      };
      mockPdfAnnotationImporterService = {
        importFromAttachment: jest.fn().mockResolvedValue({ imported: 3 }),
      };

      controller = new AnnotationsController(
        mockAnnotationsService as any,
        mockPdfAnnotationImporterService as any,
      );
    });

    it('should list annotations by delegating to AnnotationsService', async () => {
      const res = await controller.listAnnotations(
        'user-1',
        'att-1',
        '0',
        'highlight',
      );
      expect(
        mockAnnotationsService.getAnnotationsByAttachment,
      ).toHaveBeenCalledWith('user-1', 'att-1', 0, 'highlight');
      expect(res).toEqual([{ id: 'annot-1' }]);
    });

    it('should create annotation by delegating to AnnotationsService', async () => {
      const dto: any = { type: 'highlight', pageIndex: 1, color: '#ffeb3b' };
      const res = await controller.createAnnotation('user-1', 'att-1', dto);
      expect(mockAnnotationsService.createAnnotation).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          attachmentId: 'att-1',
          type: 'highlight',
          pageIndex: 1,
          color: '#ffeb3b',
          authorId: 'user-1',
        }),
      );
      expect(res).toEqual({ id: 'annot-1', color: '#ffeb3b' });
    });

    it('should update annotation by delegating to AnnotationsService', async () => {
      const dto: any = { expectedVersion: 1, color: '#ff0000' };
      const res = await controller.updateAnnotation(
        'user-1',
        'att-1',
        'annot-1',
        undefined,
        dto,
      );
      expect(mockAnnotationsService.updateAnnotation).toHaveBeenCalledWith(
        'user-1',
        'annot-1',
        1,
        { color: '#ff0000' },
      );
      expect(res).toEqual({ id: 'annot-1', color: '#ff0000' });
    });

    it('should delete annotation by delegating to AnnotationsService', async () => {
      const res = await controller.deleteAnnotation(
        'user-1',
        'att-1',
        'annot-1',
        '1',
      );
      expect(mockAnnotationsService.deleteAnnotation).toHaveBeenCalledWith(
        'user-1',
        'annot-1',
        1,
      );
      expect(res).toEqual({ id: 'annot-1', deleted: true });
    });

    it('should batch upsert annotations by delegating to AnnotationsService', async () => {
      const dto: any = { upserts: [{ pageIndex: 1 }], deletes: ['annot-old'] };
      const res = await controller.batchUpsertAnnotations(
        'user-1',
        'att-1',
        dto,
      );
      expect(
        mockAnnotationsService.batchUpsertAnnotations,
      ).toHaveBeenCalledWith('user-1', 'att-1', {
        upserts: dto.upserts,
        deletes: dto.deletes,
      });
      expect(res).toEqual({ created: [], updated: [], deleted: [] });
    });

    it('should import external annotations by delegating to PdfAnnotationImporterService', async () => {
      const res = await controller.importExternalAnnotations('user-1', 'att-1');
      expect(
        mockPdfAnnotationImporterService.importFromAttachment,
      ).toHaveBeenCalledWith('user-1', 'att-1');
      expect(res).toEqual({ imported: 3 });
    });

    it('should throw NotFoundException when annotation deletion fails', async () => {
      mockAnnotationsService.deleteAnnotation.mockResolvedValueOnce(false);
      await expect(
        controller.deleteAnnotation(
          'user-1',
          'att-1',
          'nonexistent-annot',
          '1',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
