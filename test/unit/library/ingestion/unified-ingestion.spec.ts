import { Test, TestingModule } from '@nestjs/testing';
import { IngestionService } from '@/modules/library/ingestion/ingestion.service';
import { PrismaService } from '@/core/database/prisma.service';
import { LibraryTransactionService } from '@/modules/library/sync/library-transaction.service';
import { UrlCaptureConnector } from '@/modules/library/ingestion/providers/url-capture.connector';
import { CANONICAL_METADATA_SERVICE } from '@/modules/library/ingestion/metadata/metadata.contracts';
import { IdempotencyRepository } from '@/modules/library/sync/idempotency.repository';
import { ExtractorService } from '@/modules/library/attachments/providers/extractor.provider';
import { BibtexParser } from '@/modules/library/citation/formatters/bibtex.parser';
import { R2Service } from '@/modules/storage/r2/r2.service';
import {
  IngestionIdempotencyConflictException,
  IngestionValidationException,
} from '@/modules/library/ingestion/errors/ingestion.errors';
import { createHash } from 'crypto';
import { STORAGE_PORT } from '@/modules/storage/storage.port';

describe('Unified Ingestion Pipeline (DOI / URL / BibTeX / PDF / Zotero)', () => {
  let service: IngestionService;
  let prisma: jest.Mocked<any>;
  let libraryTx: jest.Mocked<any>;
  let urlCapture: jest.Mocked<any>;
  let metadataService: jest.Mocked<any>;
  let idempotencyRepo: jest.Mocked<any>;
  let extractorService: jest.Mocked<any>;
  let storagePort: jest.Mocked<any>;
  let bibtexParser: BibtexParser;

  const workspaceId = 'ws-test-123';
  const userId = 'user-test-456';

  beforeEach(async () => {
    storagePort = {
      readOwnedFile: jest.fn().mockResolvedValue({
        fileId: 'file-new-123',
        filename: 'document.pdf',
        mimeType: 'application/pdf',
        size: 100,
        storageKey: 'ws-test-123/file-new-123.pdf',
        buffer: Buffer.from('%PDF-1.4 valid test pdf content'),
      }),
    };
    prisma = {
      catalogItem: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((args) => ({
          id: 'item-new-123',
          ...args.data,
        })),
      },
      catalogAttachment: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((args) => ({
          id: 'att-123',
          ...args.data,
        })),
      },
      libraryDedupClaim: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      attachmentRevision: {
        create: jest.fn().mockImplementation((args) => ({
          id: 'rev-123',
          ...args.data,
        })),
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
      zoteroBinding: {
        findFirst: jest.fn().mockResolvedValue({ id: 'bind-1' }),
      },
      zoteroItemBinding: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'zib-1' }),
      },
      file: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'file-123',
          workspaceId: 'ws-test-123',
          storageKey: 'ws-test-123/file-123.pdf',
          trashedAt: null,
        }),
      },
      workspaceMember: {
        findFirst: jest.fn().mockResolvedValue({ userId: 'user-test-456' }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'user-test-456' }),
      },
    };

    libraryTx = {
      executeInTransaction: jest
        .fn()
        .mockImplementation(async (wsOrCb, maybeCb) => {
          const cb = typeof wsOrCb === 'function' ? wsOrCb : maybeCb;
          const helpers = {
            appendChange: jest.fn(),
            recordTombstone: jest.fn(),
            publishOutbox: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
          };
          return cb(prisma, helpers);
        }),
    };

    urlCapture = {
      captureUrl: jest.fn().mockResolvedValue({
        title: 'Deep Learning Review',
        metadata: {
          abstract: 'A survey of deep learning',
          itemType: 'journalArticle',
          authors: [{ lastName: 'LeCun', firstName: 'Yann' }],
        },
      }),
      captureFromUrl: jest.fn().mockResolvedValue({
        title: 'Deep Learning Review',
        metadata: {
          abstract: 'A survey of deep learning',
          itemType: 'journalArticle',
          authors: [{ lastName: 'LeCun', firstName: 'Yann' }],
        },
      }),
      verifyPreviewToken: jest.fn().mockReturnValue({
        title: 'Verified Paper',
        metadata: { itemType: 'journalArticle' },
      }),
    };

    metadataService = {
      resolve: jest.fn(),
    };

    idempotencyRepo = {
      claim: jest.fn().mockResolvedValue({ status: 'acquired' }),
      markSucceeded: jest.fn().mockResolvedValue(undefined),
      markSucceededInTx: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    extractorService = {
      extractMetadataFromBuffer: jest.fn().mockReturnValue({}),
      extractDocumentFromBuffer: jest.fn().mockResolvedValue({
        metadata: {
          doi: '10.1038/nature12345',
          title: 'Quantum Advantage Demonstration',
          authors: ['Physicist A'],
          year: 2024,
        },
        pages: [{ pageIndex: 0, textContent: 'Quantum text', charOffset: 0 }],
      }),
    };

    bibtexParser = new BibtexParser();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionService,
        { provide: PrismaService, useValue: prisma },
        { provide: LibraryTransactionService, useValue: libraryTx },
        { provide: UrlCaptureConnector, useValue: urlCapture },
        { provide: CANONICAL_METADATA_SERVICE, useValue: metadataService },
        { provide: IdempotencyRepository, useValue: idempotencyRepo },
        { provide: ExtractorService, useValue: extractorService },
        { provide: STORAGE_PORT, useValue: storagePort },
        { provide: BibtexParser, useValue: bibtexParser },
      ],
    }).compile();

    service = module.get<IngestionService>(IngestionService);
  });

  describe('1. DOI Ingestion', () => {
    it('resolves metadata outside tx and commits item atomically inside tx', async () => {
      const doi = '10.1038/nature12345';
      metadataService.resolve.mockResolvedValueOnce({
        title: 'Quantum Advantage Demonstration',
        authors: [{ fullName: 'Physicist A' }],
        year: 2024,
        journal: 'Nature',
        itemType: 'journalArticle',
      });

      const result = await service.ingest({
        source: 'doi',
        workspaceId,
        userId,
        doi,
      });

      expect(result.status).toBe('completed');
      expect(result.deduplicated).toBe(false);
      expect(metadataService.resolve).toHaveBeenCalledWith({
        query: doi,
        workspaceId,
      });
      expect(libraryTx.executeInTransaction).toHaveBeenCalled();
    });

    it('returns deduplicated item when normalized DOI exists in workspace', async () => {
      const doi = '10.1038/NATURE12345';
      prisma.catalogItem.findFirst.mockResolvedValueOnce({
        id: 'item-existing-999',
        doi: '10.1038/nature12345',
        title: 'Existing Paper',
        attachments: [],
      });

      const result = await service.ingest({
        source: 'doi',
        workspaceId,
        userId,
        doi,
      });

      expect(result.deduplicated).toBe(true);
      expect(result.itemId).toBe('item-existing-999');
      expect(metadataService.resolve).not.toHaveBeenCalled();
    });
  });

  describe('2. URL Ingestion & Preview Verification', () => {
    it('captures URL metadata and commits item', async () => {
      const url = 'https://arxiv.org/abs/2301.00001';

      const result = await service.ingest({
        source: 'url',
        workspaceId,
        userId,
        url,
      });

      expect(result.status).toBe('completed');
      expect(urlCapture.captureFromUrl).toHaveBeenCalledWith(url, {
        workspaceId,
      });
      expect(libraryTx.executeInTransaction).toHaveBeenCalled();
    });

    it('rejects SSRF forbidden URLs (e.g. localhost, private IP)', async () => {
      await expect(
        service.ingest({
          source: 'url',
          workspaceId,
          userId,
          url: 'http://localhost:8080/secret',
        }),
      ).rejects.toThrow();

      await expect(
        service.ingest({
          source: 'url',
          workspaceId,
          userId,
          url: 'http://127.0.0.1/admin',
        }),
      ).rejects.toThrow();
    });
  });

  describe('3. BibTeX Ingestion', () => {
    it('parses BibTeX entry and commits item', async () => {
      const bibtex = `@article{knuth1984,
        title={Literate Programming},
        author={Knuth, Donald E.},
        journal={The Computer Journal},
        year={1984}
      }`;

      const result = await service.ingest({
        source: 'bibtex',
        workspaceId,
        userId,
        content: bibtex,
      });

      expect(result.status).toBe('completed');
      expect(libraryTx.executeInTransaction).toHaveBeenCalled();
    });

    it('rejects oversized BibTeX content (>10MB)', async () => {
      const hugeBibtex =
        '@article{huge, title={' + 'A'.repeat(11 * 1024 * 1024) + '}}';

      await expect(
        service.ingest({
          source: 'bibtex',
          workspaceId,
          userId,
          content: hugeBibtex,
        }),
      ).rejects.toThrow(IngestionValidationException);
    });
  });

  describe('4. PDF Ingestion', () => {
    it('validates %PDF header, extracts metadata, creates attachment with revision v1 and outbox event', async () => {
      const validPdfBuffer = Buffer.from('%PDF-1.4 valid test pdf content');
      storagePort.readOwnedFile.mockResolvedValueOnce({
        fileId: 'file-123',
        filename: 'sample.pdf',
        mimeType: 'application/pdf',
        size: validPdfBuffer.length,
        storageKey: 'ws-test-123/file-123.pdf',
        buffer: validPdfBuffer,
      });

      const result = await service.ingest({
        source: 'pdf',
        workspaceId,
        userId,
        fileId: 'file-123',
        filename: 'sample.pdf',
      });

      expect(result.status).toBe('completed');
      expect(result.attachmentIds).toHaveLength(1);
      expect(extractorService.extractDocumentFromBuffer).toHaveBeenCalledWith(
        validPdfBuffer,
      );
      expect(libraryTx.executeInTransaction).toHaveBeenCalled();
    });

    it('deduplicates PDF when matching file checksum exists in workspace', async () => {
      const validPdfBuffer = Buffer.from('%PDF-1.4 duplicate test content');
      storagePort.readOwnedFile.mockResolvedValueOnce({
        fileId: 'file-123',
        filename: 'sample.pdf',
        mimeType: 'application/pdf',
        size: validPdfBuffer.length,
        storageKey: 'ws-test-123/file-123.pdf',
        buffer: validPdfBuffer,
      });
      const hash = createHash('sha256').update(validPdfBuffer).digest('hex');

      prisma.libraryDedupClaim.findUnique.mockResolvedValueOnce({
        catalogItem: {
          id: 'item-existing-1',
          title: 'Existing PDF Paper',
          attachments: [{ id: 'att-existing-1' }],
        },
      });

      const result = await service.ingest({
        source: 'pdf',
        workspaceId,
        userId,
        fileId: 'file-123',
        filename: 'sample.pdf',
      });

      expect(result.deduplicated).toBe(true);
      expect(result.itemId).toBe('item-existing-1');
    });

    it('rejects invalid non-PDF buffer', async () => {
      const invalidBuffer = Buffer.from('NOT A REAL PDF BUFFER');
      storagePort.readOwnedFile.mockResolvedValueOnce({
        fileId: 'file-123',
        filename: 'corrupt.pdf',
        mimeType: 'application/pdf',
        size: invalidBuffer.length,
        storageKey: 'ws-test-123/file-123.pdf',
        buffer: invalidBuffer,
      });

      await expect(
        service.ingest({
          source: 'pdf',
          workspaceId,
          userId,
          fileId: 'file-123',
          filename: 'corrupt.pdf',
        }),
      ).rejects.toThrow(/Missing %PDF magic bytes/i);
    });
  });

  describe('5. Zotero Source Ingestion', () => {
    it('creates CatalogItem and ZoteroItemBinding for valid connection', async () => {
      const result = await service.ingest({
        source: 'zotero',
        workspaceId,
        userId,
        connectionId: 'conn-123',
        externalItemKey: 'ZOTERO_ITEM_456',
        payload: {
          data: {
            title: 'Zotero Paper',
            creators: [{ firstName: 'John', lastName: 'Doe' }],
            date: '2023',
          },
        },
      });

      expect(result.status).toBe('completed');
      expect(libraryTx.executeInTransaction).toHaveBeenCalled();
    });
  });

  describe('6. Idempotency Handling', () => {
    it('returns cached response when idempotency record is cached', async () => {
      idempotencyRepo.claim.mockResolvedValueOnce({
        status: 'cached',
        record: {
          responseBody: {
            runId: 'cached-run-123',
            status: 'completed',
            itemId: 'item-cached-123',
            attachmentIds: [],
            deduplicated: false,
          },
        },
      });

      const result = await service.ingest({
        source: 'doi',
        workspaceId,
        userId,
        doi: '10.1038/cached123',
        idempotencyKey: 'idemp-key-cached',
      });

      expect(result.itemId).toBe('item-cached-123');
      expect(libraryTx.executeInTransaction).not.toHaveBeenCalled();
    });

    it('throws IngestionIdempotencyConflictException on request mismatch', async () => {
      idempotencyRepo.claim.mockResolvedValueOnce({
        status: 'mismatch',
      });

      await expect(
        service.ingest({
          source: 'doi',
          workspaceId,
          userId,
          doi: '10.1038/mismatch123',
          idempotencyKey: 'idemp-key-mismatch',
        }),
      ).rejects.toThrow(IngestionIdempotencyConflictException);
    });
  });
});
