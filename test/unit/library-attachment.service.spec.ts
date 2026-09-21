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
import { AttachmentsService } from '@/modules/library/reader/application/services/attachments.service';
import { AttachmentsController } from '@/modules/library/reader/presentation/attachments.controller';
import { WebSnapshotService } from '@/modules/library/reader/application/services/web-snapshot.service';
import { IdentifyStage } from '@/modules/library/ingestion/infrastructure/stages/identify.stage';
import { ExtractionHandler } from '@/modules/library/reader/application/handlers/extraction.handler';
import { CommandRepository } from '@/modules/library/bibliography/infrastructure/repositories/command.repository';
import { IStoragePort } from '@/modules/storage/storage.port';

describe('Library Attachments & Storage Integration Suite', () => {
  let mockStoragePort: jest.Mocked<IStoragePort>;
  let mockPrisma: any;
  let mockRepo: any;
  let mockTx: any;
  let mockItemExistencePort: any;

  beforeEach(() => {
    mockStoragePort = {
      uploadFile: jest.fn().mockResolvedValue({
        fileId: 'storage-file-123',
        url: '/api/files/storage-file-123/content',
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
        contentUrl: '/api/files/storage-file-123/content',
        buffer: Buffer.from('%PDF-1.4 sample content'),
      }),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      linkFile: jest.fn().mockResolvedValue(undefined),
      getPresignedUploadUrl: jest.fn().mockResolvedValue({
        uploadUrl: 'https://r2.cloudflarestorage.com/upload-url',
        storageKey: 'uploads/file-uuid',
        fileUuid: 'file-uuid-777',
        expiresIn: 3600,
      }),
      uploadBuffer: jest.fn().mockResolvedValue({
        path: 'snapshots/web.html',
        url: '/api/files/snapshots/web.html',
      }),
    };

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
      metadataSourceRecord: {
        create: jest.fn().mockResolvedValue({ id: 'source-1' }),
      },
    };

    mockRepo = {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findManyByItemId: jest.fn().mockResolvedValue([]),
      updateLinkedFile: jest.fn().mockImplementation((fileId, itemId) => {
        return mockStoragePort.linkFile({
          fileId,
          linkedToType: 'Paper',
          linkedToId: itemId,
        });
      }),
      delete: jest.fn().mockResolvedValue({ id: 'att-1' }),
    };

    mockTx = {
      executeInTransaction: jest.fn().mockImplementation((cb) => {
        const txMock = {
          attachment: mockPrisma.attachment,
          attachmentRevision: mockPrisma.attachmentRevision,
          item: mockPrisma.item,
        };
        const helpersMock = {
          appendChange: jest.fn().mockResolvedValue(undefined),
          publishOutbox: jest.fn().mockResolvedValue(undefined),
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
        url: '/api/files/storage-file-123/content',
        fileId: 'storage-file-123',
        revisions: [{ revisionNumber: 1 }],
      });

      const result = await service.createAttachment({
        userId: 'user-1',
        itemId: 'item-1',
        filename: 'nature_paper.pdf',
        url: '/api/files/storage-file-123/content',
        fileId: 'storage-file-123',
        size: 2048,
        mimeType: 'application/pdf',
      });

      expect(result.id).toBe('att-1');
      expect(mockRepo.updateLinkedFile).toHaveBeenCalledWith(
        'storage-file-123',
        'item-1',
        expect.anything(),
      );
      expect(mockStoragePort.linkFile).toHaveBeenCalledWith({
        fileId: 'storage-file-123',
        linkedToType: 'Paper',
        linkedToId: 'item-1',
      });
    });

    it('should delete attachment from database AND trigger storagePort.deleteFile for quota reclamation', async () => {
      mockRepo.findFirst.mockResolvedValue({
        id: 'att-1',
        fileId: 'storage-file-123',
        url: '/api/files/storage-file-123/content',
        item: { id: 'item-1', userId: 'user-1' },
      });

      const result = await service.deleteAttachment('user-1', 'att-1');

      expect(result).toEqual({ success: true });
      expect(mockPrisma.attachment.delete).toHaveBeenCalledWith({
        where: { id: 'att-1' },
      });
      expect(mockStoragePort.deleteFile).toHaveBeenCalledWith(
        'storage-file-123',
      );
    });

    it('should extract fileId from URL regex if attachment.fileId was not set, and delete from storage', async () => {
      mockRepo.findFirst.mockResolvedValue({
        id: 'att-2',
        fileId: null,
        url: '/api/v1/library/files/storage-file-456/content',
        item: { id: 'item-1', userId: 'user-1' },
      });

      const result = await service.deleteAttachment('user-1', 'att-2');

      expect(result).toEqual({ success: true });
      expect(mockStoragePort.deleteFile).toHaveBeenCalledWith(
        'storage-file-456',
      );
    });

    it('should add revision, update Attachment.fileId to eliminate Ghost Revision bug, and link file in storage', async () => {
      mockRepo.findUnique.mockResolvedValue({
        id: 'att-1',
        itemId: 'item-1',
        fileId: 'old-file-123',
        url: '/api/files/old-file-123/content',
        size: 2048n,
        fileHash: 'old-hash',
        filename: 'paper.pdf',
        item: { id: 'item-1', userId: 'user-1' },
        revisions: [{ revisionNumber: 1 }],
      });

      mockPrisma.attachment.update.mockResolvedValue({
        id: 'att-1',
        fileId: 'new-file-456',
        size: 4096n,
        fileHash: 'new-hash',
        url: '/api/files/new-file-456/content',
      });

      const result = await service.addRevision('user-1', 'att-1', {
        fileId: 'new-file-456',
        url: '/api/files/new-file-456/content',
        fileHash: 'new-hash',
        sizeBytes: 4096,
        comment: 'Version 2 with corrected proofs',
      });

      expect(mockPrisma.attachment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'att-1' },
          data: expect.objectContaining({
            fileId: 'new-file-456',
            size: 4096n,
          }),
        }),
      );

      expect(mockPrisma.attachmentRevision.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            attachmentId: 'att-1',
            fileId: 'new-file-456',
            revisionNumber: 2,
            sizeBytes: 4096n,
            comment: 'Version 2 with corrected proofs',
          }),
        }),
      );

      expect(mockRepo.updateLinkedFile).toHaveBeenCalledWith(
        'new-file-456',
        'item-1',
        expect.anything(),
      );
    });

    it('should return cached thumbnail from storage driver if it exists', async () => {
      const mockDriver: any = {
        exists: jest.fn().mockResolvedValue(true),
        getStream: jest.fn().mockResolvedValue({
          stream: (async function* () {
            yield Buffer.from('CACHED_WEBP_THUMBNAIL');
          })(),
        }),
      };
      const mockNodeRepo: any = {
        findById: jest.fn().mockResolvedValue({
          id: 'file-1',
          blobId: 'blob-123',
        }),
      };

      const thumbnailService = new AttachmentsService(
        mockRepo,
        mockTx,
        { itemExists: jest.fn().mockResolvedValue(true) } as any,
        mockStoragePort,
        mockDriver,
        mockNodeRepo,
      );

      mockRepo.findFirst.mockResolvedValue({
        id: 'att-1',
        fileId: 'file-1',
        item: { id: 'item-1', userId: 'user-1' },
      });

      const result = await thumbnailService.getThumbnail('user-1', 'att-1');

      expect(result.mimeType).toBe('image/webp');
      expect(result.buffer.toString()).toBe('CACHED_WEBP_THUMBNAIL');
      expect(mockDriver.exists).toHaveBeenCalledWith(
        'thumbnails/blob-123.webp',
      );
    });

    it('should generate thumbnail on-the-fly and cache when not present in driver', async () => {
      const mockDriver: any = {
        exists: jest.fn().mockResolvedValue(false),
        put: jest.fn().mockResolvedValue(undefined),
      };
      const mockNode: any = {
        id: 'file-1',
        blobId: 'blob-123',
        metadata: {},
        updateMetadata: jest.fn(),
      };
      const mockNodeRepo: any = {
        findById: jest.fn().mockResolvedValue(mockNode),
        update: jest.fn().mockResolvedValue(mockNode),
      };
      const mockThumbGenerator: any = {
        generateThumbnail: jest
          .fn()
          .mockResolvedValue(Buffer.from('GENERATED_WEBP')),
      };

      const thumbnailService = new AttachmentsService(
        mockRepo,
        mockTx,
        { itemExists: jest.fn().mockResolvedValue(true) } as any,
        mockStoragePort,
        mockDriver,
        mockNodeRepo,
        mockThumbGenerator,
      );

      mockRepo.findFirst.mockResolvedValue({
        id: 'att-1',
        fileId: 'file-1',
        item: { id: 'item-1', userId: 'user-1' },
      });

      const result = await thumbnailService.getThumbnail('user-1', 'att-1');

      expect(result.mimeType).toBe('image/webp');
      expect(result.buffer.toString()).toBe('GENERATED_WEBP');
      expect(mockThumbGenerator.generateThumbnail).toHaveBeenCalledWith(
        expect.any(Buffer),
      );
      expect(mockDriver.put).toHaveBeenCalledWith(
        'thumbnails/blob-123.webp',
        expect.any(Buffer),
        expect.objectContaining({ mimeType: 'image/webp' }),
      );
    });
  });

  describe('AttachmentsController', () => {
    let controller: AttachmentsController;
    let mockAttachmentsService: any;
    let mockWebSnapshotService: any;

    beforeEach(() => {
      mockAttachmentsService = {
        getItemAttachment: jest.fn(),
        getItemAttachments: jest.fn(),
        createAttachment: jest.fn(),
        deleteAttachment: jest.fn(),
      };
      mockWebSnapshotService = {
        captureAndAttach: jest.fn(),
      };
      controller = new AttachmentsController(
        mockAttachmentsService,
        mockWebSnapshotService,
        mockStoragePort,
      );
    });

    it('should upload multipart files through storagePort with project scoping', async () => {
      const mockReq: any = {
        parts: async function* () {
          yield {
            type: 'file',
            filename: 'thesis.pdf',
            mimetype: 'application/pdf',
            toBuffer: async () => Buffer.from('PDF_CONTENT'),
          };
        },
      };

      const projId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const res = await controller.uploadLibraryFile(
        'user-1',
        mockReq,
        projId,
        undefined,
      );

      expect(res.success).toBe(true);
      expect(res.fileId).toBe('storage-file-123');
      expect(mockStoragePort.uploadFile).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          projectId: projId,
          filename: 'thesis.pdf',
          mimeType: 'application/pdf',
          source: 'library',
        }),
      );
    });

    it('should provide presigned upload URL via storagePort', async () => {
      const projId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const res = await controller.presign(
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
      expect(mockStoragePort.getPresignedUploadUrl).toHaveBeenCalledWith({
        userId: 'user-1',
        projectId: projId,
        filename: 'big_dataset.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 50000000,
        contentHash: undefined,
        scope: 'library',
      });
    });

    it('should stream thumbnail with WebP mimeType and 24h cache headers', async () => {
      mockAttachmentsService.getThumbnail = jest.fn().mockResolvedValue({
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
        undefined,
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
        'public, max-age=86400',
      );
      expect(mockRes.send).toHaveBeenCalledWith(
        Buffer.from('WEBP_STREAM_DATA'),
      );
    });
  });

  describe('WebSnapshotService', () => {
    let snapshotService: WebSnapshotService;
    let mockAttachmentsService: any;

    beforeEach(() => {
      mockAttachmentsService = {
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
      const res = await snapshotService.captureAndAttach(
        'https://arxiv.org/abs/2301.00001',
        'item-1',
        'user-1',
      );

      expect(res.attachment).toBeDefined();
      expect(mockStoragePort.uploadFile).toHaveBeenCalledWith({
        userId: 'user-1',
        filename: expect.stringMatching(/Snapshot_arxiv-paper-snapshot/),
        buffer: expect.any(Buffer),
        mimeType: 'text/html; charset=utf-8',
        source: 'library_snapshot',
      });
      expect(mockAttachmentsService.createAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: 'storage-file-123',
          url: '/api/files/storage-file-123/content',
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

      stage = new IdentifyStage(
        mockDoiParser,
        mockBibtexParser,
        mockRisParser,
        mockNormalizer,
        mockStoragePort,
        mockPdf,
      );
    });

    it('should extract PDF metadata even when scopeId is undefined (personal library)', async () => {
      const candidates = await stage.execute(
        'run-1',
        {
          kind: 'FILE',
          fileId: 'storage-file-123',
          filename: 'transformer.pdf',
        },
        undefined, // scopeId is undefined for personal library!
      );

      expect(candidates).toHaveLength(1);
      expect(mockStoragePort.readOwnedFile).toHaveBeenCalledWith({
        fileId: 'storage-file-123',
        projectId: undefined,
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
        findUniqueAttachment: jest.fn().mockResolvedValue({
          id: 'att-1',
          itemId: 'item-1',
          fileId: null,
          url: '/api/files/storage-file-123/content',
          file: null,
        }),
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
        mockSearch,
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

  describe('CommandRepository (Item Purge & Attachment Storage Cleanup)', () => {
    let repo: CommandRepository;

    beforeEach(() => {
      repo = new CommandRepository(mockPrisma, mockStoragePort);
    });

    it('should delete storage files for all item attachments before purging the item', async () => {
      mockPrisma.item.findFirst.mockResolvedValue({
        id: 'item-to-purge',
        deletedAt: new Date(), // in trash
      });
      mockPrisma.attachment.findMany.mockResolvedValue([
        {
          id: 'att-1',
          fileId: 'storage-file-1',
          url: '/api/files/storage-file-1/content',
        },
        {
          id: 'att-2',
          fileId: null,
          url: '/api/v1/library/files/storage-file-2/content',
        },
      ]);

      const res = await repo.purge('user-1', 'item-to-purge');

      expect(res).toBe(true);
      expect(mockStoragePort.deleteFile).toHaveBeenCalledWith('storage-file-1');
      expect(mockStoragePort.deleteFile).toHaveBeenCalledWith('storage-file-2');
      expect(mockPrisma.item.delete).toHaveBeenCalledWith({
        where: { id: 'item-to-purge' },
      });
    });
  });
});
