import { Test, TestingModule } from '@nestjs/testing';
import { IngestionService } from '@/modules/library/ingestion/ingestion.service';
import { PrismaService } from '@/core/database/prisma.service';
import { LibraryTransactionService } from '@/modules/library/sync-core/library-transaction.service';
import { CatalogService } from '@/modules/library/catalog/catalog.service';
import { UrlCaptureConnector } from '@/modules/library/ingestion/url-capture.connector';
import { CANONICAL_METADATA_SERVICE } from '@/modules/library/ingestion/metadata/metadata.contracts';
import { IdempotencyRepository } from '@/modules/library/sync-core/idempotency.repository';
import { AttachmentsService } from '@/modules/library/attachments/attachments.service';
import { ExtractorService } from '@/modules/library/attachments/extractor.service';
import { BibtexParser } from '@/modules/library/citation/formatters/bibtex.parser';
import { FullTextIndexer } from '@/modules/library/discovery/full-text-indexer';
import {
  IngestionIdempotencyConflictException,
  IngestionValidationException,
} from '@/modules/library/ingestion/ingestion.errors';
import { createHash } from 'crypto';

describe('Unified Ingestion Pipeline (DOI / URL / BibTeX / PDF / Zotero)', () => {
  let service: IngestionService;
  let prisma: jest.Mocked<any>;
  let libraryTx: jest.Mocked<any>;
  let catalogService: jest.Mocked<any>;
  let urlCapture: jest.Mocked<any>;
  let metadataService: jest.Mocked<any>;
  let idempotencyRepo: jest.Mocked<any>;
  let attachmentsService: jest.Mocked<any>;
  let extractorService: jest.Mocked<any>;
  let bibtexParser: BibtexParser;
  let fullTextIndexer: jest.Mocked<any>;

  const workspaceId = 'ws-test-123';
  const userId = 'user-test-456';

  beforeEach(async () => {
    prisma = {
      catalogItem: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      catalogAttachment: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((args) => ({
          id: 'att-123',
          ...args.data,
        })),
      },
      catalogTag: {
        upsert: jest.fn().mockResolvedValue({ id: 'tag-1', name: 'AI' }),
      },
      catalogItemTag: {
        upsert: jest.fn().mockResolvedValue({ id: 'cit-1' }),
      },
      capturePreview: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      zoteroBinding: {
        findFirst: jest.fn().mockResolvedValue({ id: 'bind-1' }),
      },
      zoteroItemBinding: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'zib-1' }),
      },
    };

    libraryTx = {
      executeInTransaction: jest.fn().mockImplementation(async (cb) => {
        const helpers = {
          appendChange: jest.fn(),
          recordTombstone: jest.fn(),
          publishOutbox: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
        };
        return cb(prisma, helpers);
      }),
    };

    catalogService = {
      createItem: jest.fn().mockImplementation((ws, data) => ({
        id: 'item-new-123',
        workspaceId: ws,
        title: data.title,
        itemType: data.itemType,
        doi: data.doi,
        url: data.url,
      })),
    };

    urlCapture = {
      captureFromUrl: jest.fn().mockResolvedValue({
        title: 'Deep Learning Review',
        abstract: 'A survey of deep learning',
        url: 'https://example.com/paper',
        itemType: 'journalArticle',
        creators: [{ lastName: 'LeCun', firstName: 'Yann' }],
      }),
      hashToken: jest.fn().mockReturnValue('hashed_token'),
      calculateMetadataDigest: jest.fn().mockReturnValue('digest_123'),
      attachPreviewToken: jest.fn().mockImplementation((meta) => ({
        ...meta,
        previewToken: 'preview.token.signed',
      })),
      verifyPreviewToken: jest.fn().mockReturnValue({ valid: true }),
    };

    metadataService = {
      resolve: jest.fn(),
    };

    idempotencyRepo = {
      claim: jest.fn().mockResolvedValue({ status: 'claimed' }),
      markSucceeded: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    attachmentsService = {
      calculateChecksum: jest.fn().mockImplementation((buf: Buffer) =>
        createHash('sha256').update(buf).digest('hex'),
      ),
    };

    extractorService = {
      extractMetadataFromBuffer: jest.fn().mockReturnValue({
        title: 'Attention Paper Extracted',
        doi: '10.1000/182',
        authors: ['Vaswani, Ashish'],
        year: 2017,
      }),
      extractFromBuffer: jest.fn().mockResolvedValue('Attention is all you need full text contents'),
    };

    bibtexParser = new BibtexParser();

    fullTextIndexer = {
      indexAttachmentPages: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionService,
        { provide: PrismaService, useValue: prisma },
        { provide: LibraryTransactionService, useValue: libraryTx },
        { provide: CatalogService, useValue: catalogService },
        { provide: UrlCaptureConnector, useValue: urlCapture },
        { provide: CANONICAL_METADATA_SERVICE, useValue: metadataService },
        { provide: IdempotencyRepository, useValue: idempotencyRepo },
        { provide: AttachmentsService, useValue: attachmentsService },
        { provide: ExtractorService, useValue: extractorService },
        { provide: BibtexParser, useValue: bibtexParser },
        { provide: FullTextIndexer, useValue: fullTextIndexer },
      ],
    }).compile();

    service = module.get<IngestionService>(IngestionService);
  });

  describe('1. Unified DOI Ingestion', () => {
    it('successfully ingests DOI via canonical metadata resolution and short tx commit', async () => {
      metadataService.resolve.mockResolvedValue({
        canonicalId: 'doi:10.1038/s41586-020-2649-2',
        metadata: {
          title: 'AlphaFold Structure Prediction',
          authors: ['Jumper, John', 'Hassabis, Demis'],
          year: 2021,
          journal: 'Nature',
          itemType: 'journalArticle',
          tags: ['Structural Biology', 'AI'],
        },
      });

      const result = await service.ingest({
        source: 'doi',
        workspaceId,
        userId,
        doi: '10.1038/s41586-020-2649-2',
        idempotencyKey: 'idem-doi-1',
      });

      expect(result.status).toBe('completed');
      expect(result.deduplicated).toBe(false);
      expect(result.itemId).toBe('item-new-123');
      expect(idempotencyRepo.claim).toHaveBeenCalledWith(
        workspaceId,
        'idem-doi-1',
        expect.any(String),
        86400,
      );
      expect(idempotencyRepo.markSucceeded).toHaveBeenCalled();
    });

    it('returns deduplicated item when item with same DOI already exists', async () => {
      metadataService.resolve.mockResolvedValue({
        canonicalId: 'doi:10.1000/182',
        metadata: { title: 'Existing Item' },
      });

      prisma.catalogItem.findFirst.mockResolvedValue({
        id: 'existing-item-999',
        workspaceId,
        title: 'Existing Item',
        doi: '10.1000/182',
      });

      const result = await service.ingest({
        source: 'doi',
        workspaceId,
        userId,
        doi: '10.1000/182',
      });

      expect(result.status).toBe('completed');
      expect(result.deduplicated).toBe(true);
      expect(result.itemId).toBe('existing-item-999');
      expect(catalogService.createItem).not.toHaveBeenCalled();
    });
  });

  describe('2. Unified URL Ingestion', () => {
    it('ingests URL with web scraping and safe validation', async () => {
      const result = await service.ingest({
        source: 'url',
        workspaceId,
        userId,
        url: 'https://example.com/paper',
      });

      expect(result.status).toBe('completed');
      expect(result.deduplicated).toBe(false);
      expect(catalogService.createItem).toHaveBeenCalledWith(
        workspaceId,
        expect.objectContaining({
          title: 'Deep Learning Review',
          url: 'https://example.com/paper',
        }),
        expect.any(Object),
      );
    });

    it('rejects SSRF violation on local private addresses', async () => {
      await expect(
        service.ingest({
          source: 'url',
          workspaceId,
          userId,
          url: 'http://127.0.0.1:8080/secret',
        }),
      ).rejects.toThrow(/SSRF violation/);
    });
  });

  describe('3. Unified BibTeX Ingestion', () => {
    it('parses BibTeX entry and creates CatalogItem with outbox atomically', async () => {
      const bibtex = `@article{devlin2018bert,
        title={BERT: Pre-training of Deep Bidirectional Transformers},
        author={Devlin, Jacob and Chang, Ming-Wei and Lee, Kenton},
        year={2018}
      }`;

      const result = await service.ingest({
        source: 'bibtex',
        workspaceId,
        userId,
        content: bibtex,
      });

      expect(result.status).toBe('completed');
      expect(result.deduplicated).toBe(false);
      expect(catalogService.createItem).toHaveBeenCalledWith(
        workspaceId,
        expect.objectContaining({
          title: 'BERT: Pre-training of Deep Bidirectional Transformers',
          year: 2018,
        }),
        expect.any(Object),
      );
    });
  });

  describe('4. Unified PDF Ingestion', () => {
    it('processes PDF buffer, calculates SHA-256, binds attachment and triggers async indexing', async () => {
      const dummyPdfBuffer = Buffer.from('%PDF-1.4 sample content');

      const result = await service.ingest({
        source: 'pdf',
        workspaceId,
        userId,
        filename: 'attention.pdf',
        buffer: dummyPdfBuffer,
        size: dummyPdfBuffer.length,
      });

      expect(result.status).toBe('completed');
      expect(result.attachmentIds).toHaveLength(1);
      expect(prisma.catalogAttachment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            attachmentType: 'primary_pdf',
            filename: 'attention.pdf',
          }),
        }),
      );
    });

    it('rejects PDF exceeding maximum size limit (50MB)', async () => {
      await expect(
        service.ingest({
          source: 'pdf',
          workspaceId,
          userId,
          filename: 'huge.pdf',
          size: 60 * 1024 * 1024,
        }),
      ).rejects.toThrow(IngestionValidationException);
    });

    it('deduplicates attachment if identical fileHash already exists in workspace', async () => {
      const dummyPdfBuffer = Buffer.from('%PDF-1.4 existing pdf');
      const hash = createHash('sha256').update(dummyPdfBuffer).digest('hex');

      prisma.catalogAttachment.findFirst.mockResolvedValue({
        id: 'att-existing-777',
        catalogItemId: 'item-existing-888',
        fileHash: hash,
        catalogItem: { id: 'item-existing-888', workspaceId, deletedAt: null },
      });

      const result = await service.ingest({
        source: 'pdf',
        workspaceId,
        userId,
        filename: 'duplicate.pdf',
        buffer: dummyPdfBuffer,
        size: dummyPdfBuffer.length,
      });

      expect(result.status).toBe('completed');
      expect(result.deduplicated).toBe(true);
      expect(result.itemId).toBe('item-existing-888');
      expect(result.attachmentIds).toEqual(['att-existing-777']);
      expect(prisma.catalogAttachment.create).not.toHaveBeenCalled();
    });
  });

  describe('5. Unified Zotero Ingestion', () => {
    it('ingests Zotero item, binds ZoteroItemBinding, and emits outbox event', async () => {
      const result = await service.ingest({
        source: 'zotero',
        workspaceId,
        userId,
        connectionId: 'conn-1',
        externalItemKey: 'ZOTERO_KEY_123',
        payload: {
          title: 'Zotero Paper Reference',
          itemType: 'journalArticle',
          year: 2023,
          authors: ['Smith, John'],
        },
      });

      expect(result.status).toBe('completed');
      expect(result.deduplicated).toBe(false);
      expect(prisma.zoteroItemBinding.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            remoteKey: 'ZOTERO_KEY_123',
            entityType: 'item',
          }),
        }),
      );
    });
  });

  describe('6. Idempotency & Conflict Controls', () => {
    it('returns cached response directly on idempotency cache hit without opening new transaction', async () => {
      const cachedResult = {
        runId: 'run-cached-1',
        status: 'completed' as const,
        itemId: 'item-cached-99',
        attachmentIds: [],
        deduplicated: false,
      };

      idempotencyRepo.claim.mockResolvedValue({
        status: 'cached',
        record: { responseBody: cachedResult },
      });

      const result = await service.ingest({
        source: 'doi',
        workspaceId,
        userId,
        doi: '10.1000/182',
        idempotencyKey: 'idem-cached-key',
      });

      expect(result).toEqual(cachedResult);
      expect(libraryTx.executeInTransaction).not.toHaveBeenCalled();
      expect(metadataService.resolve).not.toHaveBeenCalled();
    });

    it('throws IngestionIdempotencyConflictException when claim returns mismatch', async () => {
      idempotencyRepo.claim.mockResolvedValue({
        status: 'mismatch',
      });

      await expect(
        service.ingest({
          source: 'doi',
          workspaceId,
          userId,
          doi: '10.1000/182',
          idempotencyKey: 'idem-mismatched-key',
        }),
      ).rejects.toThrow(IngestionIdempotencyConflictException);
    });
  });
});
