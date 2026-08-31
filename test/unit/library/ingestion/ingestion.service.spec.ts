import { Test, TestingModule } from '@nestjs/testing';
import { IngestionService } from '@/modules/library/ingestion/ingestion.service';
import { PrismaService } from '@/core/database/prisma.service';
import { TransactionService } from '@/modules/library/sync/services/transaction.service';
import { IdempotencyRepository } from '@/modules/library/sync/repositories/idempotency.repository';
import { PdfExtractorProvider } from '@/modules/library/attachments/providers/pdf-extractor.provider';
import { BibtexParser } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { UrlCaptureProvider } from '@/modules/library/ingestion/providers/url-capture.provider';
import { METADATA_PORT } from '@/modules/library/ingestion/metadata/types/metadata.types';
import { STORAGE_PORT } from '@/modules/storage/storage.port';

import { CatalogService } from '@/modules/library/catalog/catalog.service';

describe('IngestionService (Canonical)', () => {
  let service: IngestionService;
  let prisma: jest.Mocked<any>;
  let libraryTx: jest.Mocked<any>;
  let urlCapture: jest.Mocked<any>;
  let metadataService: jest.Mocked<any>;
  let idempotencyRepo: jest.Mocked<any>;
  let extractorService: jest.Mocked<any>;
  let storagePort: jest.Mocked<any>;
  let catalogService: jest.Mocked<any>;

  beforeEach(async () => {
    catalogService = {
      createItem: jest.fn().mockResolvedValue({
        id: 'item-123',
        title: 'Attention Is All You Need',
        authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
        year: 2017,
      }),
    };
    prisma = {
      catalogItem: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((args) => ({
          id: 'item-123',
          ...args.data,
        })),
      },
      catalogAttachment: {
        create: jest.fn().mockImplementation((args) => ({
          id: 'att-123',
          ...args.data,
        })),
      },
      attachmentRevision: {
        create: jest.fn().mockResolvedValue({ id: 'rev-1' }),
      },
      outboxEvent: {
        create: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
      },
      libraryChange: {
        create: jest.fn().mockResolvedValue({ id: 'change-1' }),
      },
      ingestionRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-1' }),
        update: jest.fn().mockResolvedValue({ id: 'run-1' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      capturePreview: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      catalogTag: { upsert: jest.fn().mockResolvedValue({ id: 'tag-1' }) },
      catalogItemTag: { upsert: jest.fn().mockResolvedValue({ id: 'cit-1' }) },
      libraryDedupClaim: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'claim-1' }),
        upsert: jest.fn().mockResolvedValue({ id: 'claim-1' }),
      },
    };

    libraryTx = {
      executeInTransaction: jest
        .fn()
        .mockImplementation(async (wsOrCb, maybeCb) => {
          const cb = typeof wsOrCb === 'function' ? wsOrCb : maybeCb;
          const helpers = {
            appendChange: jest.fn(),
            publishOutbox: jest.fn(),
          };
          return cb(prisma, helpers);
        }),
    };

    urlCapture = {
      captureUrl: jest.fn().mockResolvedValue({
        title: 'Blog Post',
        url: 'https://blog.example.com/article',
        metadata: { itemType: 'webpage' },
      }),
      captureFromUrl: jest.fn().mockResolvedValue({
        title: 'Blog Post',
        url: 'https://blog.example.com/article',
        metadata: { itemType: 'webpage' },
      }),
      hashToken: jest.fn().mockReturnValue('hash123'),
      calculateMetadataDigest: jest.fn().mockReturnValue('digest123'),
      attachPreviewToken: jest.fn().mockImplementation((meta) => ({
        ...meta,
        previewToken: 'preview.token.123',
      })),
      verifyPreviewToken: jest.fn().mockReturnValue({ valid: true }),
    };

    metadataService = {
      resolve: jest.fn(),
    };

    idempotencyRepo = {
      claim: jest.fn().mockResolvedValue({ status: 'acquired' }),
      markSucceeded: jest.fn().mockResolvedValue(undefined),
      markSucceededInTx: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    extractorService = {
      extractDocumentFromBuffer: jest.fn().mockResolvedValue({
        metadata: {},
        pages: [],
      }),
    };

    storagePort = {
      readOwnedFile: jest.fn().mockResolvedValue({
        fileId: 'file-123',
        filename: 'document.pdf',
        mimeType: 'application/pdf',
        size: 100,
        storageKey: 'ws-1/file-123.pdf',
        buffer: Buffer.from('%PDF-1.4 Mock'),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionService,
        { provide: PrismaService, useValue: prisma },
        { provide: TransactionService, useValue: libraryTx },
        { provide: IdempotencyRepository, useValue: idempotencyRepo },
        { provide: PdfExtractorProvider, useValue: extractorService },
        { provide: STORAGE_PORT, useValue: storagePort },
        { provide: BibtexParser, useValue: new BibtexParser() },
        { provide: UrlCaptureProvider, useValue: urlCapture },
        { provide: METADATA_PORT, useValue: metadataService },
        { provide: CatalogService, useValue: catalogService },
      ],
    }).compile();

    service = module.get(IngestionService);
  });

  describe('ingestDoi', () => {
    it('resolves metadata outside tx, creates CatalogItem with real title/authors/year, and publishes outbox', async () => {
      metadataService.resolve.mockResolvedValue({
        title: 'Attention Is All You Need',
        authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
        year: 2017,
        journal: 'NeurIPS',
        itemType: 'journalArticle',
        tags: ['AI', 'Transformers'],
      });

      const result = await service.ingestDoi('ws-1', 'user-1', {
        doi: '10.5555/3295222',
      });

      expect(metadataService.resolve).toHaveBeenCalledWith({
        query: '10.5555/3295222',
        workspaceId: 'ws-1',
      });
      expect(result).toBeDefined();
      expect(libraryTx.executeInTransaction).toHaveBeenCalled();
    });
  });

  describe('captureUrl', () => {
    it('calls urlConnector.captureUrl with sanitized parameters', async () => {
      const res = await service.captureUrl(
        'https://blog.example.com/article',
        'ws-1',
      );

      expect(urlCapture.captureFromUrl).toHaveBeenCalledWith(
        'https://blog.example.com/article',
        { workspaceId: 'ws-1' },
      );
      expect(res.title).toBe('Blog Post');
    });
  });
});
