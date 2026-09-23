import { Test, TestingModule } from '@nestjs/testing';
import zlib from 'zlib';
import { ExtractionHandler } from '@/modules/library/reader/application/handlers/extraction.handler';
import { ExtractionRepository } from '@/modules/library/reader/infrastructure/repositories/extraction.repository';
import { PdfProvider } from '@/modules/library/reader/infrastructure/providers/pdf.provider';
import { QueryRepository } from '@/modules/library/bibliography/infrastructure/repositories/query.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { fromPartial } from '@total-typescript/shoehorn';

describe('Library Claim Check / Tiered Storage Pattern', () => {
  const itemId = '11111111-1111-4111-8111-111111111111';
  const attachmentId = '22222222-2222-4222-8222-222222222222';
  const storageFileId = '33333333-3333-4333-8333-333333333333';

  describe('ExtractionHandler Offloading (Producer)', () => {
    let handler: ExtractionHandler;
    let mockExtractionRepo: any;
    let mockPdf: any;
    let mockStoragePort: any;

    beforeEach(() => {
      mockExtractionRepo = {
        claimPendingOrRetryable: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueAttachment: jest.fn().mockResolvedValue({
          id: attachmentId,
          itemId,
          filename: 'paper.pdf',
          fileId: 'raw-pdf-file-id',
          item: {
            id: itemId,
            title: 'Uploaded Document',
            userId: 'user-1',
          },
        }),
        saveMetadataSourceRecord: jest.fn().mockResolvedValue({ id: 'meta-1' }),
        updateItem: jest.fn().mockResolvedValue({}),
        countContributors: jest.fn().mockResolvedValue(1),
        markReady: jest.fn().mockResolvedValue({}),
        markFailed: jest.fn().mockResolvedValue({}),
      };

      mockPdf = {
        extractDocumentFromBuffer: jest.fn().mockResolvedValue({
          pages: [{ pageIndex: 0, text: 'Hello world' }],
          metadata: {
            title: 'Attention Is All You Need',
            abstract: 'The dominant sequence models...',
            doi: '10.1234/test',
          },
          sections: [
            { heading: '1. Introduction', text: 'Recurrent models...' },
            { heading: '2. Model Architecture', text: 'Most competitive...' },
          ],
          figures: [{ caption: 'Figure 1: The Transformer' }],
          tables: [{ caption: 'Table 1: BLEU scores' }],
          formulas: [{ formula: 'E = mc^2' }],
          references: [
            { rawText: 'Vaswani et al. 2017', title: 'Attention Is All You Need' },
          ],
        }),
      };

      mockStoragePort = {
        readOwnedFile: jest.fn().mockResolvedValue({
          fileId: 'raw-pdf-file-id',
          buffer: Buffer.from('%PDF-1.4 mock pdf content'),
        }),
        uploadFile: jest.fn().mockResolvedValue({
          fileId: storageFileId,
          url: `/api/files/${storageFileId}`,
          path: `extractions/${itemId}/grobid_fulltext.json.gz`,
        }),
      };

      handler = new ExtractionHandler(
        mockExtractionRepo,
        mockPdf,
        mockStoragePort,
        fromPartial({
          indexAttachmentPages: jest.fn().mockResolvedValue(undefined),
        }),
      );
    });

    it('should compress and offload fulltext structure to StoragePort, saving a Claim Check record in Postgres', async () => {
      await handler.handle({
        id: 'event-1',
        aggregateId: attachmentId,
        eventType: 'library.attachment.extraction_requested',
        payload: { attachmentId, itemId },
      } as any);

      // Verify that storagePort.uploadFile was called with gzip compressed json
      expect(mockStoragePort.uploadFile).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          filename: `grobid_fulltext_${itemId}.json.gz`,
          mimeType: 'application/gzip',
          source: 'reader.grobid_fulltext',
        }),
      );

      // Verify the uploaded buffer can be decompressed to the original full-text tree
      const uploadedBuffer = mockStoragePort.uploadFile.mock.calls[0][0].buffer;
      const decompressed = JSON.parse(
        zlib.gunzipSync(uploadedBuffer).toString('utf-8'),
      );
      expect(decompressed.title).toBe('Attention Is All You Need');
      expect(decompressed.sections).toHaveLength(2);
      expect(decompressed.figures).toHaveLength(1);

      // Verify that extractionRepo saved the lightweight Claim Check payload in Postgres
      expect(mockExtractionRepo.saveMetadataSourceRecord).toHaveBeenCalledWith(
        itemId,
        'grobid_fulltext',
        expect.objectContaining({
          isOffloaded: true,
          fileId: storageFileId,
          storageKey: `extractions/${itemId}/grobid_fulltext.json.gz`,
          sectionCount: 2,
          figureCount: 1,
          tableCount: 1,
          formulaCount: 1,
          referenceCount: 1,
          title: 'Attention Is All You Need',
        }),
      );
    });

    it('should fallback to inline JSON in Postgres if StoragePort upload fails', async () => {
      mockStoragePort.uploadFile.mockRejectedValueOnce(
        new Error('S3 Connection Timeout'),
      );

      await handler.handle({
        id: 'event-1',
        aggregateId: attachmentId,
        eventType: 'library.attachment.extraction_requested',
        payload: { attachmentId, itemId },
      } as any);

      // Should still succeed without crashing, saving inline payload
      expect(mockExtractionRepo.saveMetadataSourceRecord).toHaveBeenCalledWith(
        itemId,
        'grobid_fulltext',
        expect.objectContaining({
          title: 'Attention Is All You Need',
          sections: expect.any(Array),
          sectionCount: 2,
        }),
      );

      expect(mockExtractionRepo.markReady).toHaveBeenCalledWith(attachmentId);
    });
  });

  describe('QueryRepository Hydration (Consumer)', () => {
    let repo: QueryRepository;
    let mockPrisma: any;
    let mockStoragePort: any;

    beforeEach(() => {
      mockPrisma = {
        itemMetadata: {
          findFirst: jest.fn(),
        },
      };

      mockStoragePort = {
        readOwnedFile: jest.fn(),
      };

      repo = new QueryRepository(mockPrisma as any, mockStoragePort);
    });

    it('should transparently hydrate offloaded Claim Check records from StoragePort', async () => {
      const fullSections = [
        { heading: '1. Introduction', text: 'Deep Learning...' },
      ];
      const compressedPayload = zlib.gzipSync(
        Buffer.from(
          JSON.stringify({
            sections: fullSections,
            figures: [{ caption: 'Fig 1' }],
            tables: [],
            formulas: [],
            references: [],
          }),
          'utf-8',
        ),
      );

      // DB only returns the lightweight Claim Check
      mockPrisma.itemMetadata.findFirst.mockResolvedValue({
        id: 'meta-1',
        itemId,
        sourceProvider: 'grobid_fulltext',
        rawPayload: {
          isOffloaded: true,
          fileId: storageFileId,
          title: 'Attention Is All You Need',
          abstract: 'The Transformer...',
          sectionCount: 1,
        },
      });

      mockStoragePort.readOwnedFile.mockResolvedValue({
        fileId: storageFileId,
        buffer: compressedPayload,
      });

      const result = await repo.findItemMetadata(itemId, 'grobid_fulltext');

      expect(result).toBeDefined();
      expect(mockStoragePort.readOwnedFile).toHaveBeenCalledWith({
        fileId: storageFileId,
      });

      const payload = result?.rawPayload as Record<string, any>;
      expect(payload.isOffloaded).toBe(true);
      expect(payload.title).toBe('Attention Is All You Need');
      expect(payload.sections).toEqual(fullSections);
      expect(payload.figures).toEqual([{ caption: 'Fig 1' }]);
    });

    it('should return inline legacy records directly without calling StoragePort', async () => {
      mockPrisma.itemMetadata.findFirst.mockResolvedValue({
        id: 'meta-legacy',
        itemId,
        sourceProvider: 'grobid_fulltext',
        rawPayload: {
          title: 'Legacy Paper',
          sections: [{ heading: 'Legacy' }],
        },
      });

      const result = await repo.findItemMetadata(itemId, 'grobid_fulltext');

      expect(mockStoragePort.readOwnedFile).not.toHaveBeenCalled();
      const payload = result?.rawPayload as Record<string, any>;
      expect(payload.title).toBe('Legacy Paper');
      expect(payload.sections).toHaveLength(1);
    });
  });
});
