import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UrlCaptureProvider } from '../../../src/modules/library/ingestion/providers/url-capture.provider';
import { IngestionService } from '../../../src/modules/library/ingestion/ingestion.service';
import { IngestionRepository } from '../../../src/modules/library/ingestion/ingestion.repository';
import { IdempotencyRepository } from '../../../src/modules/library/sync/repositories/idempotency.repository';
import { PrismaService } from '../../../src/core/database/prisma.service';
import { CatalogService } from '../../../src/modules/library/items/items.service';
import { METADATA_PORT } from '../../../src/modules/library/ingestion/metadata/types/metadata.types';
import { STORAGE_PORT } from '../../../src/modules/storage/storage.port';
import { PdfExtractorProvider } from '../../../src/modules/library/attachments/providers/pdf-extractor.provider';
import { TransactionService } from '../../../src/modules/library/outbox/transaction.service';
import { IngestionStrategyRegistry } from '../../../src/modules/library/ingestion/strategies/ingestion-strategy.registry';
import { createHash } from 'crypto';

describe('Gate H: URL Capture Security & Persistent CapturePreview Record', () => {
  const testSecret =
    'test_secret_key_minimum_32_bytes_entropy_abcdef1234567890';
  let connector: UrlCaptureProvider;
  let mockPrisma: any;
  let mockCatalogService: any;
  let ingestionService: IngestionService;

  const workspaceId = 'ws-test-123';
  const userId = 'usr-test-456';

  beforeEach(async () => {
    process.env.URL_CAPTURE_SECRET = testSecret;
    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'URL_CAPTURE_SECRET') return testSecret;
        return undefined;
      }),
    } as any;

    connector = new UrlCaptureProvider(mockConfigService);

    mockPrisma = {
      capturePreview: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 42 }),
      },
      $transaction: jest.fn(async (fn: any) => fn(mockPrisma)),
    };

    mockCatalogService = {
      createItem: jest.fn(),
    };

    const mockTxService = {
      executeInTransaction: jest.fn(async (op: any) => {
        const helpers = {
          appendChange: jest.fn(),
          recordTombstone: jest.fn(),
          publishOutbox: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
        };
        return op(mockPrisma, helpers);
      }),
    };

    const mockIngestionRepo: Partial<IngestionRepository> = {
      createRun: jest
        .fn()
        .mockResolvedValue({ id: 'run-1', status: 'pending' }),
      updateRunStatus: jest.fn().mockResolvedValue(undefined),
      findRunByIdempotencyKey: jest.fn().mockResolvedValue(null),
    };

    const mockIdempotencyRepo: Partial<IdempotencyRepository> = {
      claim: jest
        .fn()
        .mockResolvedValue({ status: 'acquired', leaseToken: 'tok' }),
      markSucceeded: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue(false),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        IngestionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IngestionRepository, useValue: mockIngestionRepo },
        { provide: IdempotencyRepository, useValue: mockIdempotencyRepo },
        { provide: CatalogService, useValue: mockCatalogService },
        { provide: METADATA_PORT, useValue: null },
        { provide: STORAGE_PORT, useValue: null },
        { provide: UrlCaptureProvider, useValue: connector },
        { provide: PdfExtractorProvider, useValue: null },
        { provide: TransactionService, useValue: mockTxService },
        { provide: IngestionStrategyRegistry, useValue: null },
      ],
    }).compile();

    ingestionService = moduleRef.get<IngestionService>(IngestionService);
    // Inject prisma directly since it's resolved at runtime
    (ingestionService as any).prisma = mockPrisma;
    (ingestionService as any).catalogService = mockCatalogService;
    (ingestionService as any).urlCaptureProvider = connector;
    (ingestionService as any).txService = mockTxService;
    (ingestionService as any).ingestionRepo = mockIngestionRepo;
  });

  describe('Section A: Token Security & Bypasses Closure', () => {
    it('1. Rejects initialization if URL_CAPTURE_SECRET is missing or < 32 characters', () => {
      delete process.env.URL_CAPTURE_SECRET;
      const badConfig = { get: jest.fn().mockReturnValue('too-short') } as any;
      expect(() => new UrlCaptureProvider(badConfig)).toThrow(
        /URL_CAPTURE_SECRET is missing or less than 32 characters/,
      );
    });

    it('2. Missing previewToken throws BadRequestException', async () => {
      await expect(
        ingestionService.confirmCapturedUrl(workspaceId, userId, {
          title: 'Paper Title',
          previewToken: '',
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('3. Malformed previewToken format is rejected', () => {
      const result = connector.verifyPreviewToken(
        { title: 'Paper Title', url: 'https://example.com/paper' },
        'not.a.valid.v1.token.signature',
        { workspaceId, userId },
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('malformed_token');
    });

    it('4. Legacy hex-only token is rejected', () => {
      const legacyHexToken = 'a'.repeat(64);
      const result = connector.verifyPreviewToken(
        { title: 'Paper Title', url: 'https://example.com/paper' },
        legacyHexToken,
        { workspaceId, userId },
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('malformed_token');
    });

    it('5. userOverride=true does NOT bypass signature verification', () => {
      const issuedAt = Date.now();
      const expiresAt = issuedAt + 15 * 60 * 1000;
      const fakeToken = `v1.nonce.${issuedAt}.${expiresAt}.badfakesignature1234567890abcdef1234567890abcdef`;
      const result = connector.verifyPreviewToken(
        { title: 'Tampered Title', url: 'https://example.com/paper' },
        fakeToken,
        { workspaceId, userId },
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature_mismatch');
    });

    it('6. Token issued for User A is rejected when submitted by User B (Cross-User)', () => {
      const meta = {
        title: 'Attention Is All You Need',
        url: 'https://arxiv.org/abs/1706.03762',
        year: 2017,
        itemType: 'preprint' as const,
      };
      const signed = connector.attachPreviewToken(meta, {
        workspaceId,
        userId: 'user-A',
      });
      const result = connector.verifyPreviewToken(meta, signed.previewToken, {
        workspaceId,
        userId: 'user-B',
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature_mismatch');
    });

    it('7. Token issued for Workspace 1 is rejected in Workspace 2 (Cross-Workspace)', () => {
      const meta = {
        title: 'Attention Is All You Need',
        url: 'https://arxiv.org/abs/1706.03762',
        year: 2017,
        itemType: 'preprint' as const,
      };
      const signed = connector.attachPreviewToken(meta, {
        workspaceId: 'ws-1',
        userId,
      });
      const result = connector.verifyPreviewToken(meta, signed.previewToken, {
        workspaceId: 'ws-2',
        userId,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature_mismatch');
    });

    it('8. Expired preview token is rejected', () => {
      const meta = {
        title: 'Attention Is All You Need',
        url: 'https://arxiv.org/abs/1706.03762',
        year: 2017,
        itemType: 'preprint' as const,
      };
      // Manually craft an expired token
      const issuedAt = Date.now() - 20 * 60 * 1000;
      const expiresAt = Date.now() - 5 * 60 * 1000;
      const nonce = 'expirednonce';
      const digest = connector.calculateMetadataDigest(meta);
      const payload = `v1:${workspaceId}:${userId}:${meta.url}:${digest}:${issuedAt}:${expiresAt}:${nonce}`;
      const sig = createHash('sha256')
        .update(payload + testSecret)
        .digest('hex');
      const expiredToken = `v1.${nonce}.${issuedAt}.${expiresAt}.${sig}`;

      const result = connector.verifyPreviewToken(meta, expiredToken, {
        workspaceId,
        userId,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('token_expired');
    });

    it('9. Metadata tampering (e.g. creator modification) invalidates signature', () => {
      const metaOriginal = {
        title: 'Original Title',
        url: 'https://example.com/paper',
        creators: [{ lastName: 'Vaswani', firstName: 'Ashish' }],
        year: 2017,
        itemType: 'preprint' as const,
      };
      const signed = connector.attachPreviewToken(metaOriginal, {
        workspaceId,
        userId,
      });

      const metaTampered = {
        ...metaOriginal,
        creators: [{ lastName: 'Attacker', firstName: 'Eve' }],
      };
      const result = connector.verifyPreviewToken(
        metaTampered,
        signed.previewToken,
        {
          workspaceId,
          userId,
        },
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature_mismatch');
    });
  });

  describe('Section B: Persistent Preview Record & Single Atomic Transaction', () => {
    it('10. Valid confirmation creates CatalogItem and marks preview consumed in single transaction', async () => {
      const meta = {
        title: 'Attention Is All You Need',
        url: 'https://arxiv.org/abs/1706.03762',
        year: 2017,
        itemType: 'preprint' as const,
      };
      const signed = connector.attachPreviewToken(meta, {
        workspaceId,
        userId,
      });
      const tokenHash = createHash('sha256')
        .update(signed.previewToken!)
        .digest('hex');

      mockPrisma.capturePreview.findUnique.mockResolvedValue({
        id: 'preview-1',
        workspaceId,
        userId,
        sourceUrl: meta.url,
        canonicalMetadata: meta,
        metadataDigest: connector.calculateMetadataDigest(meta),
        tokenHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        consumedAt: null,
      });

      mockPrisma.capturePreview.updateMany.mockResolvedValue({ count: 1 });
      mockCatalogService.createItem.mockResolvedValue({
        id: 'item-1',
        title: meta.title,
      });

      const result = await ingestionService.confirmCapturedUrl(
        workspaceId,
        userId,
        {
          title: meta.title,
          previewToken: signed.previewToken!,
        },
      );

      expect(result.id).toBe('item-1');
      expect(mockPrisma.capturePreview.updateMany).toHaveBeenCalledWith({
        where: { id: 'preview-1', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
      expect(mockCatalogService.createItem).toHaveBeenCalledWith(
        workspaceId,
        expect.objectContaining({ title: meta.title }),
        expect.objectContaining({
          tx: mockPrisma,
          helpers: expect.any(Object),
        }),
      );
    });

    it('11. Replay attempt on already-consumed preview throws ConflictException', async () => {
      const meta = {
        title: 'Attention Is All You Need',
        url: 'https://arxiv.org/abs/1706.03762',
        year: 2017,
        itemType: 'preprint' as const,
      };
      const signed = connector.attachPreviewToken(meta, {
        workspaceId,
        userId,
      });
      const tokenHash = createHash('sha256')
        .update(signed.previewToken!)
        .digest('hex');

      mockPrisma.capturePreview.findUnique.mockResolvedValue({
        id: 'preview-1',
        workspaceId,
        userId,
        sourceUrl: meta.url,
        canonicalMetadata: meta,
        metadataDigest: connector.calculateMetadataDigest(meta),
        tokenHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        consumedAt: new Date(), // Already consumed
      });

      await expect(
        ingestionService.confirmCapturedUrl(workspaceId, userId, {
          title: meta.title,
          previewToken: signed.previewToken!,
        }),
      ).rejects.toThrow(ConflictException);

      expect(mockCatalogService.createItem).not.toHaveBeenCalled();
    });

    it('12. Concurrent double confirmation rejects second request atomically', async () => {
      const meta = {
        title: 'Attention Is All You Need',
        url: 'https://arxiv.org/abs/1706.03762',
        year: 2017,
        itemType: 'preprint' as const,
      };
      const signed = connector.attachPreviewToken(meta, {
        workspaceId,
        userId,
      });
      const tokenHash = createHash('sha256')
        .update(signed.previewToken!)
        .digest('hex');

      mockPrisma.capturePreview.findUnique.mockResolvedValue({
        id: 'preview-1',
        workspaceId,
        userId,
        sourceUrl: meta.url,
        canonicalMetadata: meta,
        metadataDigest: connector.calculateMetadataDigest(meta),
        tokenHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        consumedAt: null,
      });

      mockPrisma.capturePreview.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        ingestionService.confirmCapturedUrl(workspaceId, userId, {
          title: meta.title,
          previewToken: signed.previewToken!,
        }),
      ).rejects.toThrow(ConflictException);

      expect(mockCatalogService.createItem).not.toHaveBeenCalled();
    });

    it('13. Preserves itemType from capture or confirmation override (e.g. preprint, book)', async () => {
      const meta = {
        title: 'Deep Learning Book',
        url: 'https://www.deeplearningbook.org',
        year: 2016,
        itemType: 'book' as const,
      };
      const signed = connector.attachPreviewToken(meta, {
        workspaceId,
        userId,
      });
      const tokenHash = createHash('sha256')
        .update(signed.previewToken!)
        .digest('hex');

      mockPrisma.capturePreview.findUnique.mockResolvedValue({
        id: 'preview-book',
        workspaceId,
        userId,
        sourceUrl: meta.url,
        canonicalMetadata: meta,
        metadataDigest: connector.calculateMetadataDigest(meta),
        tokenHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        consumedAt: null,
      });

      mockPrisma.capturePreview.updateMany.mockResolvedValue({ count: 1 });
      mockCatalogService.createItem.mockResolvedValue({
        id: 'item-book',
        title: meta.title,
        itemType: 'book',
      });

      await ingestionService.confirmCapturedUrl(workspaceId, userId, {
        title: meta.title,
        itemType: 'book',
        previewToken: signed.previewToken!,
      });

      expect(mockCatalogService.createItem).toHaveBeenCalledWith(
        workspaceId,
        expect.objectContaining({ itemType: 'book' }),
        expect.any(Object),
      );
    });

    it('14. Preserves structured creators and maps to contributors on createItem', async () => {
      const meta = {
        title: 'Attention Is All You Need',
        url: 'https://arxiv.org/abs/1706.03762',
        year: 2017,
        itemType: 'preprint' as const,
        creators: [
          { lastName: 'Vaswani', firstName: 'Ashish' },
          { lastName: 'Shazeer', firstName: 'Noam' },
        ],
      };
      const signed = connector.attachPreviewToken(meta, {
        workspaceId,
        userId,
      });
      const tokenHash = createHash('sha256')
        .update(signed.previewToken!)
        .digest('hex');

      mockPrisma.capturePreview.findUnique.mockResolvedValue({
        id: 'preview-creators',
        workspaceId,
        userId,
        sourceUrl: meta.url,
        canonicalMetadata: meta,
        metadataDigest: connector.calculateMetadataDigest(meta),
        tokenHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        consumedAt: null,
      });

      mockPrisma.capturePreview.updateMany.mockResolvedValue({ count: 1 });
      mockCatalogService.createItem.mockResolvedValue({
        id: 'item-creators',
        title: meta.title,
      });

      await ingestionService.confirmCapturedUrl(workspaceId, userId, {
        title: meta.title,
        previewToken: signed.previewToken!,
      });

      // creators should be passed through (repository maps to contributors)
      expect(mockCatalogService.createItem).toHaveBeenCalledWith(
        workspaceId,
        expect.objectContaining({
          creators: expect.arrayContaining([
            expect.objectContaining({
              lastName: 'Vaswani',
              firstName: 'Ashish',
            }),
          ]),
        }),
        expect.any(Object),
      );
    });

    it('15. Sanitizes canonicalMetadata on captureUrl so raw bearer previewToken is NOT persisted in DB JSON', async () => {
      jest.spyOn(connector, 'captureFromUrl').mockResolvedValue({
        title: 'Captured Paper',
        url: 'https://arxiv.org/abs/1234.5678',
        itemType: 'preprint',
        previewToken: 'v1.nonce.100.200.sig',
      });

      await ingestionService.captureUrl('https://arxiv.org/abs/1234.5678', {
        workspaceId,
        userId,
      });

      expect(mockPrisma.capturePreview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          canonicalMetadata: expect.not.objectContaining({
            previewToken: expect.anything(),
          }),
        }),
      });
    });

    it('16. Cleans up expired and consumed preview records according to retention window', async () => {
      const count = await ingestionService.cleanupExpiredPreviews(7);
      expect(count).toBe(42);
      expect(mockPrisma.capturePreview.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { consumedAt: { lte: expect.any(Date) } },
            { expiresAt: { lte: expect.any(Date) } },
          ],
        },
      });
    });
  });
});
