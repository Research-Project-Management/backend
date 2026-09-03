import { Test, TestingModule } from '@nestjs/testing';
import { IngestionService } from '@/modules/library/ingestion/ingestion.service';
import { PrismaService } from '@/core/database/prisma.service';
import { IngestionRepository } from '@/modules/library/ingestion/ingestion.repository';
import { IdempotencyRepository } from '@/modules/library/sync/repositories/idempotency.repository';
import { TransactionService } from '@/modules/library/sync/services/transaction.service';
import { PdfExtractorProvider } from '@/modules/library/attachments/providers/pdf-extractor.provider';
import { UrlCaptureProvider } from '@/modules/library/ingestion/providers/url-capture.provider';
import { METADATA_PORT } from '@/modules/library/ingestion/metadata/types/metadata.types';
import { STORAGE_PORT } from '@/modules/storage/storage.port';
import { CatalogService } from '@/modules/library/catalog/catalog.service';
import { IngestionStrategyRegistry } from '@/modules/library/ingestion/strategies/ingestion-strategy.registry';

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
  let ingestionRepo: jest.Mocked<any>;

  beforeEach(async () => {
    catalogService = {
      createItem: jest.fn().mockResolvedValue({
        id: 'item-123',
        title: 'Attention Is All You Need',
        year: 2017,
        contributors: [
          {
            lastName: 'Vaswani',
            firstName: 'Ashish',
            creatorType: 'author',
            orderIndex: 0,
          },
          {
            lastName: 'Shazeer',
            firstName: 'Noam',
            creatorType: 'author',
            orderIndex: 1,
          },
        ],
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
        create: jest
          .fn()
          .mockResolvedValue({ id: 'run-1', status: 'pending', attempts: 0 }),
        update: jest.fn().mockResolvedValue({ id: 'run-1' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      capturePreview: {
        create: jest.fn().mockResolvedValue({ id: 'prev-1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
        .mockImplementation(async (wsOrCb: any, maybeCb: any) => {
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
        previewToken: 'preview.token.123',
        itemType: 'webpage',
      }),
      hashToken: jest.fn().mockReturnValue('hash123'),
      calculateMetadataDigest: jest.fn().mockReturnValue('digest123'),
      attachPreviewToken: jest.fn().mockImplementation((meta: any) => ({
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

    ingestionRepo = {
      createRun: jest
        .fn()
        .mockResolvedValue({ id: 'run-1', status: 'pending', attempts: 0 }),
      updateRunStatus: jest.fn().mockResolvedValue(undefined),
      findRunByIdempotencyKey: jest.fn().mockResolvedValue(null),
      findRunById: jest.fn().mockResolvedValue(null),
      createStage: jest.fn().mockResolvedValue({ id: 'stage-1' }),
      createCandidate: jest.fn().mockResolvedValue({ id: 'cand-1' }),
      createDecision: jest.fn().mockResolvedValue({ id: 'dec-1' }),
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
        { provide: IngestionRepository, useValue: ingestionRepo },
        { provide: IdempotencyRepository, useValue: idempotencyRepo },
        { provide: CatalogService, useValue: catalogService },
        { provide: METADATA_PORT, useValue: metadataService },
        { provide: STORAGE_PORT, useValue: storagePort },
        { provide: UrlCaptureProvider, useValue: urlCapture },
        { provide: PdfExtractorProvider, useValue: extractorService },
        { provide: TransactionService, useValue: libraryTx },
        { provide: IngestionStrategyRegistry, useValue: null },
      ],
    }).compile();

    service = module.get(IngestionService);
  });

  describe('captureUrl', () => {
    it('calls urlCaptureProvider.captureFromUrl and persists a CapturePreview record', async () => {
      const res = await service.captureUrl('https://blog.example.com/article', {
        workspaceId: 'ws-1',
        userId: 'user-1',
      });

      expect(urlCapture.captureFromUrl).toHaveBeenCalledWith(
        'https://blog.example.com/article',
        { workspaceId: 'ws-1', userId: 'user-1' },
      );
      expect(res.title).toBe('Blog Post');
    });
  });

  describe('getRunStatus', () => {
    it('returns NotFoundException when run is not found', async () => {
      ingestionRepo.findRunById.mockResolvedValue(null);
      await expect(
        service.getRunStatus('ws-1', 'nonexistent-run-id'),
      ).rejects.toThrow();
    });
  });
});
