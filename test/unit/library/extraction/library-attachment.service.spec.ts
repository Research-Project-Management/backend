jest.mock('jsdom', () => ({
  JSDOM: jest.fn().mockImplementation(() => ({
    window: {
      document: {
        querySelector: jest.fn(),
        querySelectorAll: jest.fn().mockReturnValue([]),
      },
    },
  })),
}));

jest.mock('dompurify', () => () => ({
  sanitize: (s: string) => s,
}));

jest.mock('@mozilla/readability', () => ({
  Readability: jest.fn().mockImplementation(() => ({
    parse: () => ({
      title: 'Snapshot Title',
      content: '<div>Content</div>',
      textContent: 'Content',
    }),
  })),
}));

import { fromPartial, fromAny } from '@total-typescript/shoehorn';
import { AttachmentsService } from '@/modules/library/extraction/services/attachments.service';

import { WebSnapshotService } from '@/modules/library/extraction/services/web-snapshot.service';
import { AttachmentController } from '@/modules/library/extraction/controllers/attachments.controller';
import { AttachmentStorageController } from '@/modules/library/extraction/controllers/attachment-storage.controller';
import { IdentifyStage } from '@/modules/library/ingestion/stages/identify.stage';
import { IdentifyFileResolver } from '@/modules/library/ingestion/stages/identify-file.resolver';
import { ExtractionHandler } from '@/modules/library/extraction/services/extraction.handler';
import { ExtractionMetadataSynchronizer } from '@/modules/library/extraction/services/extraction-metadata.synchronizer';
import { IFilesPort } from '@/modules/files';

describe('Library Attachments & Storage Integration Suite', () => {
  let mockStoragePort: jest.Mocked<IFilesPort>;
  let mockPrisma: any;
  let mockRepo: any;
  let mockTx: any;
  let mockItemExistencePort: any;

  beforeEach(() => {
    mockStoragePort = fromPartial({
      uploadFile: jest.fn().mockResolvedValue({
        fileId: 'storage-file-123',
        url: '/api/v1/files/storage-file-123/content',
        path: 'cas/blobs/storage-file-123',
        filename: 'nature_paper.pdf',
        size: 2048,
        mimeType: 'application/pdf',
      }),
      readOwnedFile: jest.fn().mockResolvedValue({
        fileId: 'storage-file-123',
        filename: 'nature_paper.pdf',
        mimeType: 'application/pdf',
        size: 2048,
        storageKey: 'cas/blobs/storage-file-123',
        contentUrl: '/api/v1/files/storage-file-123/content',
        buffer: Buffer.from('%PDF-1.4 sample content'),
      }),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      presignUpload: jest.fn().mockResolvedValue({
        uploadUrl: 'https://r2.cloudflarestorage.com/upload-url',
        storageKey: 'uploads/file-uuid',
        fileUuid: 'file-uuid-777',
        cleanFilename: 'big_dataset.pdf',
        deduplicated: false,
        expiresIn: 3600,
      }),
      putObject: jest.fn().mockResolvedValue(undefined),
    });

    mockPrisma = {
      attachment: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'att-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn().mockResolvedValue({ id: 'att-1' }),
      },
      attachmentRevision: {
        create: jest.fn().mockResolvedValue({ id: 'rev-1' }),
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([]),
      },
      item: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({ id: 'item-1' }),
      },
      file: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      itemMetadata: {
        create: jest.fn().mockResolvedValue({ id: 'source-1' }),
      },
      metadataSourceRecord: {
        create: jest.fn().mockResolvedValue({ id: 'source-1' }),
      },
    };

    mockRepo = {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findManyByItemId: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation((data, include) =>
          mockPrisma.attachment.create({ data, include }),
        ),
      update: jest
        .fn()
        .mockImplementation((id, data) =>
          mockPrisma.attachment.update({ where: { id }, data }),
        ),
      delete: jest.fn().mockResolvedValue({ id: 'att-1' }),
    };

    const helpersMock = {
      appendChange: jest.fn().mockResolvedValue(undefined),
      recordTombstone: jest.fn().mockResolvedValue(undefined),
      publishOutbox: jest.fn().mockResolvedValue(undefined),
    };
    mockTx = {
      helpers: helpersMock,
      executeInTransaction: jest.fn().mockImplementation((cb) => {
        const txMock = {
          attachment: mockPrisma.attachment,
          attachmentRevision: mockPrisma.attachmentRevision,
          item: mockPrisma.item,
        };
        return cb(txMock, helpersMock);
      }),
    };

    mockItemExistencePort = {
      assertExists: jest.fn().mockResolvedValue(undefined),
    };
  });

  describe('AttachmentsService', () => {
    let service: AttachmentsService;

    beforeEach(() => {
      service = new AttachmentsService(
        mockRepo,
        mockTx,
        { itemExists: jest.fn().mockResolvedValue(true) } as any,
        mockStoragePort,
      );
    });

    it('should create an attachment and link file via StoragePort', async () => {
      mockPrisma.attachment.create.mockResolvedValue({
        id: 'att-1',
        itemId: 'item-1',
        filename: 'nature_paper.pdf',
        url: '/api/v1/files/storage-file-123/content',
        fileId: 'storage-file-123',
        revisions: [{ revisionNumber: 1 }],
      });

      const result = await service.createAttachment({
        userId: 'user-1',
        itemId: 'item-1',
        filename: 'nature_paper.pdf',
        url: '/api/v1/files/storage-file-123/content',
        fileId: 'storage-file-123',
        size: 2048,
        mimeType: 'application/pdf',
      });

      expect(result.id).toBe('att-1');
      expect(mockPrisma.attachment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            linkMode: 'imported_file',
            attachmentType: 'primary_pdf',
          }),
        }),
      );
    });

    it('should create a linked_url attachment with dual-axis Zotero specifications', async () => {
      mockPrisma.attachment.create.mockResolvedValue({
        id: 'att-2',
        itemId: 'item-1',
        filename: 'Project Repository',
        url: 'https://github.com/project/flux',
        linkMode: 'linked_url',
        attachmentType: 'other',
        revisions: [{ revisionNumber: 1 }],
      });

      const result = await service.createAttachment({
        userId: 'user-1',
        itemId: 'item-1',
        filename: 'Project Repository',
        url: 'https://github.com/project/flux',
        linkMode: 'linked_url',
        attachmentType: 'other',
      });

      expect(result.id).toBe('att-2');
      expect(mockPrisma.attachment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            linkMode: 'linked_url',
            attachmentType: 'other',
            mimeType: 'text/uri-list',
          }),
        }),
      );
    });

    it('should delete attachment from database AND trigger storagePort.deleteFile for quota reclamation', async () => {
      mockRepo.findFirst.mockResolvedValue({
        id: 'att-1',
        fileId: 'storage-file-123',
        url: '/api/v1/files/storage-file-123/content',
        item: { id: 'item-1', spaceId: 'user-1', createdById: 'user-1' },
      });

      const result = await service.deleteAttachment('user-1', 'att-1');

      expect(result).toEqual({ success: true });
      expect(mockRepo.delete).toHaveBeenCalledWith('att-1', expect.anything());
      expect(mockStoragePort.deleteFile).toHaveBeenCalledWith(
        'storage-file-123',
        { spaceId: 'user-1' },
      );
    });

    it('should still release CAS blob & space quota even when countFileIdReferences reports cross-space references', async () => {
      const spaceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      mockRepo.countFileIdReferences = jest.fn().mockResolvedValue(2);
      mockRepo.findFirst.mockResolvedValue({
        id: 'att-cross-1',
        fileId: 'cas-shared-blob',
        url: '/api/v1/files/cas-shared-blob/content',
        item: { id: 'item-1', spaceId: spaceA, createdById: 'user-1' },
      });

      const result = await service.deleteAttachment(
        'user-1',
        'att-cross-1',
        spaceA,
      );

      expect(result).toEqual({ success: true });
      expect(mockRepo.countFileIdReferences).not.toHaveBeenCalled();
      expect(mockStoragePort.deleteFile).toHaveBeenCalledWith(
        'cas-shared-blob',
        { spaceId: spaceA },
      );
    });

    it('should extract fileId from URL regex if attachment.fileId was not set, and delete from storage', async () => {
      mockRepo.findFirst.mockResolvedValue({
        id: 'att-2',
        fileId: null,
        url: '/api/v1/library/files/storage-file-456/content',
        item: { id: 'item-1', spaceId: 'user-1', createdById: 'user-1' },
      });

      const result = await service.deleteAttachment('user-1', 'att-2');

      expect(result).toEqual({ success: true });
      expect(mockStoragePort.deleteFile).toHaveBeenCalledWith(
        'storage-file-456',
        { spaceId: 'user-1' },
      );
    });

    it('should queue re-extraction job and publish extraction_requested event for PDF attachment', async () => {
      mockRepo.findUnique.mockResolvedValue({
        id: 'att-1',
        itemId: 'item-1',
        filename: 'paper.pdf',
        mimeType: 'application/pdf',
        item: { id: 'item-1', userId: 'user-1' },
      });

      const result = await service.reExtractAttachment('user-1', 'att-1');

      expect(result).toEqual({
        status: 'PENDING',
        attachmentId: 'att-1',
        message: 'Re-extraction job queued successfully',
      });
      expect(mockPrisma.attachment.update).toHaveBeenCalledWith({
        where: { id: 'att-1' },
        data: {
          extractionStatus: 'PENDING',
          extractionAttempts: 0,
          extractionLastError: null,
        },
      });
      expect(mockTx.helpers.publishOutbox).toHaveBeenCalledWith(
        { userId: 'user-1' },
        'att-1',
        'library.attachment.extraction_requested',
        expect.objectContaining({
          attachmentId: 'att-1',
          itemId: 'item-1',
          userId: 'user-1',
        }),
      );
    });

    it('should return cached thumbnail from storagePort.ensurePdfThumbnail', async () => {
      mockStoragePort.ensurePdfThumbnail = jest
        .fn()
        .mockResolvedValue(Buffer.from('CACHED_WEBP_THUMBNAIL'));

      const thumbnailService = new AttachmentsService(
        mockRepo,
        mockTx,
        { itemExists: jest.fn().mockResolvedValue(true) } as any,
        mockStoragePort,
      );

      mockRepo.findFirst.mockResolvedValue({
        id: 'att-1',
        fileId: 'file-1',
        item: { id: 'item-1', userId: 'user-1' },
      });

      const result = await thumbnailService.getThumbnail('user-1', 'att-1');

      expect(result.mimeType).toBe('image/webp');
      expect(result.buffer.toString()).toBe('CACHED_WEBP_THUMBNAIL');
      expect(mockStoragePort.ensurePdfThumbnail).toHaveBeenCalledWith({
        fileId: 'file-1',
        spaceId: 'user-1',
        userId: 'user-1',
      });
    });

    it('should generate thumbnail on-the-fly via storagePort.ensurePdfThumbnail', async () => {
      mockStoragePort.ensurePdfThumbnail = jest
        .fn()
        .mockResolvedValue(Buffer.from('GENERATED_WEBP'));

      const thumbnailService = new AttachmentsService(
        mockRepo,
        mockTx,
        { itemExists: jest.fn().mockResolvedValue(true) } as any,
        mockStoragePort,
      );

      mockRepo.findFirst.mockResolvedValue({
        id: 'att-1',
        fileId: 'file-1',
        item: { id: 'item-1', userId: 'user-1' },
      });

      const result = await thumbnailService.getThumbnail('user-1', 'att-1');

      expect(result.mimeType).toBe('image/webp');
      expect(result.buffer.toString()).toBe('GENERATED_WEBP');
      expect(mockStoragePort.ensurePdfThumbnail).toHaveBeenCalledWith({
        fileId: 'file-1',
        spaceId: 'user-1',
        userId: 'user-1',
      });
    });
  });

  describe('AttachmentsController & AttachmentStorageController', () => {
    let controller: AttachmentController;
    let storageController: AttachmentStorageController;
    let mockAttachmentsService: any;
    let mockWebSnapshotService: any;
    let mockGetThumbnailUseCase: any;

    beforeEach(() => {
      mockAttachmentsService = {
        getItemAttachment: jest.fn(),
        getItemAttachments: jest.fn(),
        createAttachment: jest.fn(),
        deleteAttachment: jest.fn(),
        getThumbnail: jest.fn().mockResolvedValue({
          buffer: Buffer.from('WEBP_STREAM_DATA'),
          mimeType: 'image/webp',
        }),
      };
      mockWebSnapshotService = {
        captureAndAttach: jest.fn(),
      };
      storageController = new AttachmentStorageController(
        mockStoragePort,
        {} as any,
      );
      controller = new AttachmentController(
        mockAttachmentsService,
        mockWebSnapshotService,
      );
    });

    it('should upload multipart files through storagePort with project scoping', async () => {
      const mockReq: any = {
        parts: async function* () {
          yield {
            type: 'file',
            filename: 'thesis.pdf',
            mimetype: 'application/pdf',
            toBuffer: async () => Buffer.from('%PDF-1.7\nPDF_CONTENT'),
          };
        },
      };

      const projId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const res = await storageController.uploadLibraryFile(
        'user-1',
        mockReq,
        projId,
      );

      expect(res.success).toBe(true);
      expect(res.fileId).toBe('storage-file-123');
      expect(mockStoragePort.uploadFile).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          spaceId: projId,
          filename: 'thesis.pdf',
          mimeType: 'application/pdf',
        }),
      );
    });

    it('should provide presigned upload URL via storagePort', async () => {
      const projId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const res = await storageController.presignUpload(
        'user-1',
        {
          filename: 'big_dataset.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 50000000,
        },
        projId,
      );

      expect(res.uploadUrl).toBe('https://r2.cloudflarestorage.com/upload-url');
      expect(res.fileUuid).toBe('file-uuid-777');
      expect(mockStoragePort.presignUpload).toHaveBeenCalledWith({
        userId: 'user-1',
        spaceId: projId,
        filename: 'big_dataset.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 50000000,
        contentHash: undefined,
      });
    });

    it('should complete presigned upload with JSON-safe fields (no BigInt/blob instance) and spaceId', async () => {
      const spaceId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      mockStoragePort.completePresignedUpload = jest.fn().mockResolvedValue({
        blob: { id: 'blob-99', sizeBytes: 4096n },
        fileId: 'blob-99',
        blobId: 'blob-99',
        url: '/api/v1/files/blob-99/content',
        filename: 'paper.pdf',
        size: 4096,
        sizeBytes: 4096n,
        mimeType: 'application/pdf',
        cleanFilename: 'paper.pdf',
        isDeduplicated: false,
      });

      const res = await storageController.completePresignedUpload(
        'user-1',
        {
          storageKey: 'uploads/staging/user-1/paper.pdf',
          filename: 'paper.pdf',
          mimeType: 'application/pdf',
          size: 4096,
        },
        spaceId,
      );

      expect(mockStoragePort.completePresignedUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          spaceId,
          sizeBytes: 4096,
        }),
      );
      expect(res).toEqual({
        success: true,
        id: 'blob-99',
        fileId: 'blob-99',
        blobId: 'blob-99',
        url: '/api/v1/files/blob-99/content',
        filename: 'paper.pdf',
        size: 4096,
        mimeType: 'application/pdf',
        isDeduplicated: false,
      });
      expect(() => JSON.stringify(res)).not.toThrow();
    });

    it('should return both partUrl and uploadUrl on getMultipartPartUrl', async () => {
      mockStoragePort.getMultipartPartUrl = jest
        .fn()
        .mockResolvedValue('https://r2.example.com/part-1');

      const spaceId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const res = await storageController.getMultipartPartUrl(
        'user-1',
        'sess-1',
        '1',
        spaceId,
      );

      expect(mockStoragePort.getMultipartPartUrl).toHaveBeenCalledWith(
        'sess-1',
        1,
        { userId: 'user-1', spaceId },
      );
      expect(res).toEqual({
        partNumber: 1,
        partUrl: 'https://r2.example.com/part-1',
        uploadUrl: 'https://r2.example.com/part-1',
      });
    });

    it('should stream thumbnail with WebP mimeType and 24h cache headers', async () => {
      mockAttachmentsService.getThumbnail.mockResolvedValue({
        buffer: Buffer.from('WEBP_STREAM_DATA'),
        mimeType: 'image/webp',
      });

      const mockRes: any = {
        header: jest.fn(),
        send: jest.fn((buf) => buf),
      };

      await controller.getAttachmentThumbnail(
        'user-1',
        'att-thumb-1',
        mockRes,
        'proj-456',
      );

      expect(mockAttachmentsService.getThumbnail).toHaveBeenCalledWith(
        'user-1',
        'att-thumb-1',
        'proj-456',
      );
      expect(mockRes.header).toHaveBeenCalledWith('Content-Type', 'image/webp');
      expect(mockRes.header).toHaveBeenCalledWith(
        'Cache-Control',
        'private, max-age=86400',
      );
      expect(mockRes.header).toHaveBeenCalledWith('Vary', 'Authorization');
      expect(mockRes.send).toHaveBeenCalledWith(
        Buffer.from('WEBP_STREAM_DATA'),
      );
    });

    it('should delegate reExtractAttachment to effective attachments service', async () => {
      mockAttachmentsService.reExtractAttachment = jest.fn().mockResolvedValue({
        status: 'PENDING',
        attachmentId: 'att-1',
        message: 'Re-extraction and OCR job queued successfully',
      });

      const res = await controller.reExtractAttachment(
        'user-1',
        'att-1',
        'proj-456',
      );

      expect(res.status).toBe('PENDING');
      expect(mockAttachmentsService.reExtractAttachment).toHaveBeenCalledWith(
        'user-1',
        'att-1',
        'proj-456',
      );
    });
  });

  describe('WebSnapshotService', () => {
    let snapshotService: WebSnapshotService;
    let mockAttachmentsService: any;

    beforeEach(() => {
      mockAttachmentsService = {
        assertItemExists: jest.fn().mockResolvedValue(undefined),
        createAttachment: jest.fn().mockResolvedValue({
          id: 'att-snap-1',
          fileId: 'storage-file-123',
        }),
      };
      snapshotService = new WebSnapshotService(
        mockAttachmentsService,
        mockStoragePort,
      );

      // Mock internal HTML snapshot capture
      jest
        .spyOn(
          fromPartial<{ captureHtmlSnapshot: any }>(snapshotService),
          'captureHtmlSnapshot',
        )
        .mockResolvedValue({
          htmlContent: '<html><body>Paper title</body></html>',
          title: 'Arxiv Paper Snapshot',
          sizeBytes: 1024,
          checksum: 'hash-abc',
        });
    });

    it('should prioritize uploadFile to record CAS storageNode and fileId', async () => {
      const validItemUuid = '11111111-1111-4111-8111-111111111111';
      const res = await snapshotService.captureAndAttach(
        'https://arxiv.org/abs/2301.00001',
        validItemUuid,
        'user-1',
      );

      expect(res.attachment).toBeDefined();
      expect(mockStoragePort.uploadFile).toHaveBeenCalledWith({
        userId: 'user-1',
        spaceId: 'user-1',
        filename: expect.stringMatching(/Snapshot_arxiv-paper-snapshot/),
        buffer: expect.any(Buffer),
        mimeType: 'text/html; charset=utf-8',
      });
      expect(mockAttachmentsService.createAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: 'storage-file-123',
          url: '/api/v1/files/storage-file-123/content',
        }),
      );
    });
  });

  describe('IdentifyStage (Ingestion)', () => {
    let stage: IdentifyStage;
    let mockDoiParser: any;
    let mockBibtexParser: any;
    let mockRisParser: any;
    let mockNormalizer: any;
    let mockPdf: any;

    beforeEach(() => {
      mockDoiParser = { normalize: jest.fn((d) => d) };
      mockBibtexParser = { parse: jest.fn(() => []) };
      mockRisParser = { parse: jest.fn(() => []) };
      mockNormalizer = { normalize: jest.fn((raw) => raw) };
      mockPdf = {
        extractDocumentFromBuffer: jest.fn().mockResolvedValue({
          metadata: {
            title: 'Attention Is All You Need',
            doi: '10.1145/transformer',
          },
          pages: [],
        }),
      };

      const fileResolver = new IdentifyFileResolver(
        mockNormalizer,
        mockStoragePort,
        mockPdf,
      );

      stage = new IdentifyStage(
        mockDoiParser,
        mockBibtexParser,
        mockRisParser,
        mockNormalizer,
        mockStoragePort,
        undefined,
        fileResolver,
      );
    });

    it('should extract PDF metadata even when spaceId is undefined (personal library)', async () => {
      const candidates = await stage.execute({
        runId: 'run-1',
        payload: {
          kind: 'FILE',
          fileId: 'storage-file-123',
          filename: 'transformer.pdf',
        },
        spaceId: undefined, // spaceId is undefined for personal library!
      });

      expect(candidates).toHaveLength(1);
      expect(mockStoragePort.readOwnedFile).toHaveBeenCalledWith({
        fileId: 'storage-file-123',
        spaceId: undefined,
      });
      expect(mockPdf.extractDocumentFromBuffer).toHaveBeenCalled();
      expect(candidates[0].normalizedMetadata.title).toBe(
        'Attention Is All You Need',
      );
      expect(candidates[0].normalizedMetadata.doi).toBe('10.1145/transformer');
    });
  });

  describe('ExtractionHandler (Background PDF Text Extraction)', () => {
    let handler: ExtractionHandler;
    let mockExtractionRepo: any;
    let mockPdf: any;
    let mockSearch: any;

    beforeEach(() => {
      mockExtractionRepo = {
        claimPendingOrRetryable: jest.fn().mockResolvedValue({ count: 1 }),
        claimStaleProcessing: jest.fn().mockResolvedValue({ count: 0 }),
        findUniqueAttachment: jest.fn().mockImplementation(() =>
          Promise.resolve({
            id: 'att-1',
            itemId: 'item-1',
            fileId: null,
            url: '/api/v1/files/storage-file-123/content',
            file: null,
          }),
        ),
        updateAttachmentFileId: jest.fn().mockResolvedValue({ id: 'att-1' }),
        saveMetadataSourceRecord: jest.fn().mockResolvedValue({ id: 'rec-1' }),
        updateAttachmentMetadata: jest.fn().mockResolvedValue({ id: 'att-1' }),
        updateItem: jest.fn().mockResolvedValue({ id: 'item-1' }),
        countContributors: jest.fn().mockResolvedValue(0),
        createContributors: jest.fn().mockResolvedValue({ count: 0 }),
        markReady: jest.fn().mockResolvedValue({ id: 'att-1' }),
        markFailed: jest.fn().mockResolvedValue({ id: 'att-1' }),
        findScopePapers: jest.fn().mockResolvedValue([]),
        upsertItemCitationRelation: jest.fn().mockResolvedValue({}),
      };
      mockPdf = {
        extractDocumentFromBuffer: jest.fn().mockResolvedValue({
          metadata: { title: 'Extracted PDF' },
          pages: [{ pageNumber: 1, text: 'Hello' }],
          references: [],
          sections: [],
        }),
      };
      mockSearch = {
        indexAttachmentPages: jest.fn().mockResolvedValue(undefined),
      };

      handler = new ExtractionHandler(
        mockExtractionRepo,
        mockPdf,
        mockStoragePort,
      );
    });

    it('should resolve fileId from URL regex if attachment.fileId is missing and backfill DB', async () => {
      await handler.handle(
        fromPartial({
          id: 'event-1',
          aggregateId: 'att-1',
          eventType: 'library.attachment.extraction_requested',
          payload: { attachmentId: 'att-1' },
        }),
      );

      expect(mockStoragePort.readOwnedFile).toHaveBeenCalledWith({
        fileId: 'storage-file-123',
      });
      expect(mockExtractionRepo.updateAttachmentFileId).toHaveBeenCalledWith(
        'att-1',
        'storage-file-123',
      );
    });
  });

  describe('ExtractionMetadataSynchronizer (Space Quota Offload & Supersede Delete)', () => {
    it('offloads pdf_fulltext under LibraryItem.spaceId + createdById and deletes superseded blobs under spaceId', async () => {
      const spaceId = '33333333-3333-4333-8333-333333333333';
      const creatorId = '44444444-4444-4444-8444-444444444444';
      const mockSyncExtractionRepo: any = {
        saveMetadataSourceRecord: jest.fn().mockResolvedValue({
          id: 'meta-1',
          supersededFileIds: ['old-fulltext-file-id'],
        }),
        upsertAttachmentStructure: jest.fn().mockResolvedValue(undefined),
        countContributors: jest.fn().mockResolvedValue(0),
        updateItem: jest.fn().mockResolvedValue(undefined),
      };

      const synchronizer = new ExtractionMetadataSynchronizer(
        mockSyncExtractionRepo,
        mockTx,
        mockStoragePort,
      );

      await synchronizer.offloadFullTextAndSyncMetadata(
        {
          id: 'att-sync-1',
          itemId: 'item-sync-1',
          item: {
            id: 'item-sync-1',
            spaceId,
            createdById: creatorId,
          },
        },
        {
          metadata: { title: 'Canonical Paper' },
          pages: [{ pageNumber: 1, text: 'Page one body text' }],
          sections: [],
          references: [],
        },
        { pageCount: 1 },
      );

      expect(mockStoragePort.uploadFile).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: creatorId,
          spaceId,
          mimeType: 'application/gzip',
        }),
      );
      expect(mockStoragePort.deleteFile).toHaveBeenCalledWith(
        'old-fulltext-file-id',
        { spaceId },
      );
    });
  });
});
