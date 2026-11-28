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

import { fromPartial } from '@total-typescript/shoehorn';
import { OutboxEvent } from '@prisma/client';
import { AttachmentsService } from '@/modules/library/extraction/services/attachments.service';
import { WebSnapshotService } from '@/modules/library/extraction/services/web-snapshot.service';
import { ExtractionHandler } from '@/modules/library/extraction/services/extraction.handler';
import { ExtractionMetadataSynchronizer } from '@/modules/library/extraction/services/metadata-sync.service';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { AttachmentStorageController } from '@/modules/library/extraction/controllers/attachment-storage.controller';
import {
  buildExtractedMetadataSyncPlan,
  sanitizeExtractedItemUpdateAgainstFreshState,
} from '@/modules/library/extraction/domain/metadata-merge.policy';
import { IdempotentConsumerService } from '@/modules/library/sync/services/idempotent-consumer.service';
import { IFilesPort } from '@/modules/files/types/files.type';

describe('Library Attachments, Storage Offload, Extraction Handler & Metadata Sync', () => {
  let mockStoragePort: jest.Mocked<IFilesPort>;
  let mockPrisma: Record<string, Record<string, jest.Mock>>;
  let mockRepo: Record<string, jest.Mock>;
  let helpersMock: Record<string, jest.Mock>;
  let mockTx: { executeInTransaction: jest.Mock };

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
      ensurePdfThumbnail: jest
        .fn()
        .mockResolvedValue(Buffer.from('WEBP_THUMBNAIL')),
    });

    mockPrisma = {
      attachment: {
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'att-1' }),
      },
      attachmentRevision: {
        create: jest.fn().mockResolvedValue({ id: 'rev-1' }),
      },
      item: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    mockRepo = {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findManyByItemId: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation((data: unknown, include?: unknown) =>
          mockPrisma.attachment.create({ data, include }),
        ),
      update: jest
        .fn()
        .mockImplementation((id: string, data: unknown) =>
          mockPrisma.attachment.update({ where: { id }, data }),
        ),
      delete: jest.fn().mockResolvedValue({ id: 'att-1' }),
    };

    helpersMock = {
      appendChange: jest.fn().mockResolvedValue(undefined),
      recordTombstone: jest.fn().mockResolvedValue(undefined),
      publishOutbox: jest.fn().mockResolvedValue(undefined),
    };

    mockTx = {
      executeInTransaction: jest.fn(
        (cb: (tx: unknown, h: typeof helpersMock) => unknown) =>
          cb(
            {
              attachment: mockPrisma.attachment,
              attachmentRevision: mockPrisma.attachmentRevision,
              item: mockPrisma.item,
            },
            helpersMock,
          ),
      ),
    };
  });

  describe('AttachmentsService, WebSnapshotService & AttachmentStorageController', () => {
    it('creates imported_file and linked_url attachments, deletes CAS storage blobs, queues re-extraction, and generates thumbnails', async () => {
      const service = new AttachmentsService(
        mockRepo as never,
        mockTx as never,
        fromPartial({ itemExists: jest.fn().mockResolvedValue(true) }),
        mockStoragePort,
      );

      mockPrisma.attachment.create.mockResolvedValueOnce({
        id: 'att-1',
        itemId: 'item-1',
        filename: 'nature_paper.pdf',
        fileId: 'storage-file-123',
        revisions: [{ revisionNumber: 1 }],
      });
      await service.createAttachment({
        userId: 'user-1',
        itemId: 'item-1',
        filename: 'nature_paper.pdf',
        url: '/api/v1/files/storage-file-123/content',
        fileId: 'storage-file-123',
        size: 2048,
        mimeType: 'application/pdf',
      });
      expect(mockPrisma.attachment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            linkMode: 'imported_file',
            attachmentType: 'primary_pdf',
          }),
        }),
      );

      mockPrisma.attachment.create.mockResolvedValueOnce({
        id: 'att-2',
        itemId: 'item-1',
        filename: 'Repo',
        url: 'https://github.com/project/flux',
        linkMode: 'linked_url',
        attachmentType: 'other',
        revisions: [{ revisionNumber: 1 }],
      });
      await service.createAttachment({
        userId: 'user-1',
        itemId: 'item-1',
        filename: 'Repo',
        url: 'https://github.com/project/flux',
        linkMode: 'linked_url',
        attachmentType: 'other',
      });
      expect(mockPrisma.attachment.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            linkMode: 'linked_url',
            mimeType: 'text/uri-list',
          }),
        }),
      );

      mockRepo.findFirst.mockResolvedValueOnce({
        id: 'att-url-only',
        fileId: null,
        url: '/api/v1/library/files/storage-file-456/content',
        item: { id: 'item-1', spaceId: 'user-1', createdById: 'user-1' },
      });
      await service.deleteAttachment('user-1', 'att-url-only');
      expect(mockStoragePort.deleteFile).toHaveBeenCalledWith(
        'storage-file-456',
        { spaceId: 'user-1' },
      );

      mockRepo.findUnique.mockResolvedValueOnce({
        id: 'att-1',
        itemId: 'item-1',
        filename: 'paper.pdf',
        mimeType: 'application/pdf',
        item: { id: 'item-1', userId: 'user-1' },
      });
      const reExtract = await service.reExtractAttachment('user-1', 'att-1');
      expect(reExtract.status).toBe('PENDING');
      expect(helpersMock.publishOutbox).toHaveBeenCalledWith(
        { userId: 'user-1' },
        'att-1',
        'library.attachment.extraction_requested',
        expect.objectContaining({ attachmentId: 'att-1', itemId: 'item-1' }),
      );

      mockRepo.findFirst.mockResolvedValueOnce({
        id: 'att-1',
        fileId: 'file-1',
        item: { id: 'item-1', userId: 'user-1' },
      });
      const thumb = await service.getThumbnail('user-1', 'att-1');
      expect(thumb.mimeType).toBe('image/webp');
      expect(thumb.buffer.toString()).toBe('WEBP_THUMBNAIL');
    });

    it('handles multipart/presigned storage uploads with JSON-safe BigInt stripping and HTML web snapshots', async () => {
      const spaceId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const storageController = new AttachmentStorageController(
        mockStoragePort,
        {} as never,
      );

      mockStoragePort.completePresignedUpload = jest.fn().mockResolvedValue({
        blob: { id: 'blob-99', sizeBytes: 4096n },
        fileId: 'blob-99',
        blobId: 'blob-99',
        url: '/api/v1/files/blob-99/content',
        filename: 'paper.pdf',
        size: 4096,
        sizeBytes: 4096n,
        mimeType: 'application/pdf',
        isDeduplicated: false,
      });

      const completed = await storageController.completePresignedUpload(
        'user-1',
        {
          storageKey: 'uploads/staging/user-1/paper.pdf',
          filename: 'paper.pdf',
          mimeType: 'application/pdf',
          size: 4096,
        },
        spaceId,
      );
      expect(() => JSON.stringify(completed)).not.toThrow();
      expect(completed.fileId).toBe('blob-99');

      const mockAttSvc = {
        assertItemExists: jest.fn().mockResolvedValue(undefined),
        createAttachment: jest.fn().mockResolvedValue({
          id: 'att-snap-1',
          fileId: 'storage-file-123',
        }),
      };
      const snapshotService = new WebSnapshotService(
        mockAttSvc as never,
        mockStoragePort,
      );
      jest
        .spyOn(
          snapshotService as unknown as {
            captureHtmlSnapshot: () => Promise<unknown>;
          },
          'captureHtmlSnapshot',
        )
        .mockResolvedValue({
          htmlContent: '<html><body>Paper title</body></html>',
          title: 'Arxiv Paper Snapshot',
          sizeBytes: 1024,
          checksum: 'hash-abc',
        });

      const snapRes = await snapshotService.captureAndAttach(
        'https://arxiv.org/abs/2301.00001',
        '11111111-1111-4111-8111-111111111111',
        'user-1',
      );
      expect(snapRes.attachment).toBeDefined();
      expect(mockStoragePort.uploadFile).toHaveBeenCalledWith(
        expect.objectContaining({ mimeType: 'text/html; charset=utf-8' }),
      );
    });
  });

  describe('ExtractionHandler Idempotency & ExtractionMetadataSynchronizer Guards', () => {
    it('backfills missing attachment.fileId from URL, deduplicates duplicate outbox events, and releases lease on failure', async () => {
      const idempotentConsumer = new IdempotentConsumerService();
      idempotentConsumer.clearMemoryStore();

      const mockExtractionRepo = {
        claimPendingOrRetryable: jest.fn().mockResolvedValue({ count: 1 }),
        claimStaleProcessing: jest.fn().mockResolvedValue({ count: 0 }),
        findUniqueAttachment: jest.fn().mockResolvedValue({
          id: 'att-1',
          itemId: 'item-1',
          fileId: null,
          url: '/api/v1/files/storage-file-123/content',
          filename: 'paper.pdf',
          extractionAttempts: 1,
          item: { id: 'item-1', title: 'Uploaded Document', userId: 'user-1' },
        }),
        updateAttachmentFileId: jest.fn().mockResolvedValue({ id: 'att-1' }),
        saveMetadataSourceRecord: jest.fn().mockResolvedValue({ id: 'meta-1' }),
        updateItem: jest.fn().mockResolvedValue({}),
        countContributors: jest.fn().mockResolvedValue(1),
        markReady: jest.fn().mockResolvedValue({}),
        markFailed: jest.fn().mockResolvedValue({}),
      };

      const mockPdf = {
        extractDocumentFromBuffer: jest.fn().mockResolvedValue({
          pages: [{ pageIndex: 0, text: 'Body text' }],
          metadata: { title: 'Attention Is All You Need' },
          sections: [],
          references: [],
        }),
      };

      const handler = new ExtractionHandler(
        mockExtractionRepo as never,
        mockPdf as never,
        mockStoragePort,
        idempotentConsumer,
      );

      const event = fromPartial<OutboxEvent>({
        id: 'event-extract-1',
        aggregateId: 'att-1',
        eventType: 'library.attachment.extraction_requested',
        payload: { attachmentId: 'att-1' },
      });

      await handler.handle(event);
      expect(mockExtractionRepo.updateAttachmentFileId).toHaveBeenCalledWith(
        'att-1',
        'storage-file-123',
      );
      expect(mockPdf.extractDocumentFromBuffer).toHaveBeenCalledTimes(1);

      await handler.handle(event);
      expect(mockPdf.extractDocumentFromBuffer).toHaveBeenCalledTimes(1);

      const retryEvent = fromPartial<OutboxEvent>({
        id: 'event-extract-retry',
        aggregateId: 'att-1',
        eventType: 'library.attachment.extraction_requested',
        payload: { attachmentId: 'att-1' },
      });
      mockStoragePort.readOwnedFile.mockRejectedValueOnce(
        new Error('S3 timeout'),
      );
      await expect(handler.handle(retryEvent)).rejects.toThrow('S3 timeout');
      expect(
        await idempotentConsumer.isProcessed(
          'ExtractionHandler',
          'event-extract-retry',
        ),
      ).toBe(false);

      await handler.handle(retryEvent);
      expect(
        await idempotentConsumer.isProcessed(
          'ExtractionHandler',
          'event-extract-retry',
        ),
      ).toBe(true);
    });

    it('protects user-locked/coupled fields & CrossRef itemType, offloads fulltext with superseded blob cleanup, and syncs automatic tags/notes', async () => {
      const existingItem = {
        id: 'item-locked-1',
        title: 'User Curated Canonical Title',
        itemType: 'journalArticle',
        year: 2024,
        doi: '10.1038/s41586-024-00001-x',
        metadata: {
          lockedFields: ['title', 'year'],
          fieldProvenance: {
            itemType: {
              source: 'CrossRef',
              sourceProvider: 'CrossRef',
              confidence: 0.95,
            },
          },
        },
        extraFields: { lockedFields: ['title', 'year'] },
      };

      const syncPlan = buildExtractedMetadataSyncPlan(
        { id: 'att-1', itemId: 'item-locked-1', item: existingItem },
        {
          metadata: {
            title: 'downloaded_paper_v3.pdf',
            arxivId: '2005.14165',
            year: 2019,
            abstract: 'Extracted abstract from PDF body.',
            volume: '625',
          },
        },
      );
      expect(syncPlan.itemPatch.title).toBeUndefined();
      expect(syncPlan.itemPatch.year).toBeUndefined();
      expect(syncPlan.itemPatch.itemType).toBeUndefined();
      expect(syncPlan.itemPatch.abstract).toBe(
        'Extracted abstract from PDF body.',
      );

      const sanitized = await sanitizeExtractedItemUpdateAgainstFreshState({
        data: { ...syncPlan.itemPatch, title: 'Stale', year: 2019 },
        freshItem: existingItem,
      });
      expect(sanitized.sanitizedData.title).toBeUndefined();
      expect(sanitized.sanitizedData.year).toBeUndefined();

      const spaceId = '33333333-3333-4333-8333-333333333333';
      const creatorId = '44444444-4444-4444-8444-444444444444';
      const saveMetadataSourceRecord = jest.fn().mockResolvedValue({
        id: 'meta-1',
        supersededFileIds: ['old-fulltext-file-id'],
      });
      const synchronizer = new ExtractionMetadataSynchronizer(
        {
          saveMetadataSourceRecord,
          upsertAttachmentStructure: jest.fn().mockResolvedValue(undefined),
          countContributors: jest.fn().mockResolvedValue(1),
          updateItem: jest.fn().mockResolvedValue(undefined),
        } as unknown as ExtractionRepository,
        mockTx as never,
        mockStoragePort,
      );

      await synchronizer.offloadFullTextAndSyncMetadata(
        {
          id: 'att-sync-1',
          itemId: 'item-sync-1',
          item: { id: 'item-sync-1', spaceId, createdById: creatorId },
        },
        {
          metadata: { title: 'Canonical Paper' },
          pages: [{ pageNumber: 1, text: 'Page one body text' }],
          sections: [],
          references: [],
        } as never,
        { pageCount: 1 } as never,
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

      const tagMock = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockImplementationOnce(
            (args: { where?: { OR?: Array<{ name?: { equals?: string } }> } }) =>
              Promise.resolve(
                (args.where?.OR || []).map((c) => ({
                  id: `tag-${c.name?.equals}`,
                  name: c.name?.equals,
                  type: 'automatic',
                })),
              ),
          ),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      };
      const noteMock = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ contentMd: 'Existing note.' }]),
        create: jest.fn().mockResolvedValue({ id: 'note-1' }),
      };
      const extractionRepo = new ExtractionRepository({
        tag: tagMock,
        libraryTag: tagMock,
        itemTag: { upsert: jest.fn().mockResolvedValue({}) },
        libraryItemTag: { upsert: jest.fn().mockResolvedValue({}) },
        item: {
          findUnique: jest.fn().mockResolvedValue({ metadata: {} }),
          update: jest.fn().mockResolvedValue({}),
        },
        libraryItem: {
          findUnique: jest.fn().mockResolvedValue({ metadata: {} }),
          update: jest.fn().mockResolvedValue({}),
        },
        note: noteMock,
        libraryNote: noteMock,
      } as never);

      const syncedTags = await extractionRepo.syncItemTags({
        userId: 'user-1',
        itemId: 'item-1',
        rawTags: ['cs.AI', 'nlp'],
      });
      expect(syncedTags).toContain(
        'Computer Science - Artificial Intelligence',
      );

      expect(
        await extractionRepo.createItemNotes({
          userId: 'user-1',
          itemId: 'item-1',
          notes: [{ content: 'New extracted summary.', type: 'summary' }],
        }),
      ).toBe(1);
      expect(
        await extractionRepo.createItemNotes({
          userId: 'user-1',
          itemId: 'item-1',
          notes: [{ content: 'Existing note.' }],
        }),
      ).toBe(0);
    });
  });
});
