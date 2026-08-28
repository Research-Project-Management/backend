import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { IngestionService } from '@/modules/library/ingestion/ingestion.service';
import { PrismaService } from '@/core/database/prisma.service';
import { LibraryTransactionService } from '@/modules/library/sync-core/library-transaction.service';
import { CatalogService } from '@/modules/library/catalog/catalog.service';
import { UrlCaptureConnector } from '@/modules/library/ingestion/url-capture.connector';
import { CANONICAL_METADATA_SERVICE } from '@/modules/library/ingestion/metadata/metadata.contracts';

describe('IngestionService (Canonical)', () => {
  let service: IngestionService;
  let prisma: jest.Mocked<any>;
  let libraryTx: jest.Mocked<any>;
  let catalogService: jest.Mocked<any>;
  let urlCapture: jest.Mocked<any>;
  let metadataService: jest.Mocked<any>;

  beforeEach(async () => {
    prisma = {
      capturePreview: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      catalogTag: { upsert: jest.fn().mockResolvedValue({ id: 'tag-1' }) },
      catalogItemTag: { upsert: jest.fn().mockResolvedValue({ id: 'cit-1' }) },
    };

    libraryTx = {
      executeInTransaction: jest.fn().mockImplementation(async (cb) => {
        const helpers = {
          appendChange: jest.fn(),
          publishOutbox: jest.fn(),
        };
        return cb(prisma, helpers);
      }),
    };

    catalogService = {
      createItem: jest.fn().mockResolvedValue({
        id: 'item-123',
        title: 'Attention Is All You Need',
        itemType: 'journalArticle',
        doi: '10.5555/3295222',
      }),
    };

    urlCapture = {
      captureFromUrl: jest.fn(),
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionService,
        { provide: PrismaService, useValue: prisma },
        { provide: LibraryTransactionService, useValue: libraryTx },
        { provide: CatalogService, useValue: catalogService },
        { provide: UrlCaptureConnector, useValue: urlCapture },
        { provide: CANONICAL_METADATA_SERVICE, useValue: metadataService },
      ],
    }).compile();

    service = module.get(IngestionService);
  });

  describe('ingestDoi', () => {
    it('resolves metadata outside tx, creates CatalogItem with real title/authors/year, and publishes outbox', async () => {
      metadataService.resolve.mockResolvedValue({
        query: '10.5555/3295222',
        queryType: 'DOI',
        canonicalId: 'doi:10.5555/3295222',
        metadata: {
          title: 'Attention Is All You Need',
          authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
          year: 2017,
          journal: 'NeurIPS',
          itemType: 'journalArticle',
          tags: ['AI', 'Transformers'],
        },
        provenance: {},
        resolvedAt: new Date().toISOString(),
        policyVersion: 1,
      });

      const result = await service.ingestDoi('ws-1', 'user-1', {
        doi: '10.5555/3295222',
      });

      // 1. Metadata resolution called with clean DOI
      expect(metadataService.resolve).toHaveBeenCalledWith({
        query: '10.5555/3295222',
      });

      // 2. Catalog item created with real metadata, not a placeholder
      expect(catalogService.createItem).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          title: 'Attention Is All You Need',
          authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
          year: 2017,
          journal: 'NeurIPS',
          doi: '10.5555/3295222',
        }),
        expect.objectContaining({ tx: prisma }),
      );

      // 3. Result returned
      expect(result.id).toBe('item-123');
    });

    it('throws NotFoundException when metadataService returns null', async () => {
      metadataService.resolve.mockResolvedValue(null);

      await expect(
        service.ingestDoi('ws-1', 'user-1', { doi: '10.9999/notfound' }),
      ).rejects.toThrow(NotFoundException);

      expect(catalogService.createItem).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when DOI is empty or invalid', async () => {
      await expect(
        service.ingestDoi('ws-1', 'user-1', { doi: '   ' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('ingestBibtex', () => {
    it('creates CatalogItem with { tx, helpers } and publishes outbox atomically', async () => {
      const bibtex = `@article{vaswani2017attention,
        title={Attention Is All You Need},
        author={Vaswani, Ashish and Shazeer, Noam},
        year={2017}
      }`;

      const result = await service.ingestBibtex('ws-1', 'user-1', { bibtex });

      expect(catalogService.createItem).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          title: 'Attention Is All You Need',
          authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
          year: 2017,
        }),
        expect.objectContaining({ tx: prisma }),
      );
      expect(result.id).toBe('item-123');
    });

    it('rolls back CatalogItem if outbox publishing fails during BibTeX ingest', async () => {
      libraryTx.executeInTransaction.mockImplementation(async (cb: any) => {
        const helpers = {
          appendChange: jest.fn(),
          publishOutbox: jest
            .fn()
            .mockRejectedValue(new Error('Outbox write failed')),
        };
        return cb(prisma, helpers);
      });

      const bibtex = `@article{test, title={Test Paper}}`;

      await expect(
        service.ingestBibtex('ws-1', 'user-1', { bibtex }),
      ).rejects.toThrow('Outbox write failed');
    });
  });

  describe('captureUrl', () => {
    it('routes academic DOI URL through canonical MetadataService first', async () => {
      metadataService.resolve.mockResolvedValue({
        query: 'https://doi.org/10.1038/s41586-020-2649-2',
        queryType: 'DOI',
        canonicalId: 'doi:10.1038/s41586-020-2649-2',
        metadata: {
          title: 'AlphaFold Paper',
          authors: ['Jumper, John'],
          year: 2021,
          journal: 'Nature',
          itemType: 'journalArticle',
        },
        provenance: {},
        resolvedAt: new Date().toISOString(),
        policyVersion: 1,
      });

      const res = await service.captureUrl(
        'https://doi.org/10.1038/s41586-020-2649-2',
        { workspaceId: 'ws-1', userId: 'user-1' },
      );

      expect(metadataService.resolve).toHaveBeenCalledWith({
        query: 'https://doi.org/10.1038/s41586-020-2649-2',
      });
      expect(urlCapture.captureFromUrl).not.toHaveBeenCalled();
      expect(res.title).toBe('AlphaFold Paper');
      expect(prisma.capturePreview.create).toHaveBeenCalled();
    });

    it('falls back to UrlCaptureConnector for generic webpages', async () => {
      urlCapture.captureFromUrl.mockResolvedValue({
        title: 'Blog Post',
        url: 'https://blog.example.com/article',
        itemType: 'webpage',
      });

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
});
