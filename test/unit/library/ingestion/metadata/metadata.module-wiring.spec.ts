import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MetadataModule as CanonicalMetadataModule } from '@/modules/library/ingestion/metadata/metadata.module';
import { MetadataModule as LegacyMetadataModule } from '@/modules/library/legacy/metadata/metadata.module';
import { MetadataService as LegacyMetadataService } from '@/modules/library/legacy/metadata/metadata.service';
import {
  CANONICAL_METADATA_SERVICE,
  CanonicalMetadataResolver,
} from '@/modules/library/ingestion/metadata/metadata.contracts';
import { PrismaService } from '@/core/database/prisma.service';
import { LibraryTransactionService } from '@/modules/library/sync-core/library-transaction.service';
import { CatalogService } from '@/modules/library/catalog/catalog.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';

describe('Metadata Module Wiring & Delegation Integration', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        JwtModule.register({ global: true }),
        CanonicalMetadataModule,
        LegacyMetadataModule,
      ],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            catalogItem: { findUnique: jest.fn(), create: jest.fn() },
            $transaction: jest.fn(),
          },
        },
        {
          provide: LibraryTransactionService,
          useValue: { executeInTransaction: jest.fn() },
        },
        {
          provide: CatalogService,
          useValue: { createItem: jest.fn() },
        },
        {
          provide: RedisCacheService,
          useValue: { isReady: () => false, get: jest.fn(), set: jest.fn() },
        },
      ],
    }).compile();
  });

  it('resolves IngestionContextModule without any forwardRef cycle', () => {
    expect(module).toBeDefined();
    const canonicalService = module.get<CanonicalMetadataResolver>(
      CANONICAL_METADATA_SERVICE,
    );
    expect(canonicalService).toBeDefined();
    expect(typeof canonicalService.resolve).toBe('function');
  });

  it('Legacy MetadataService delegates to canonical when CANONICAL_METADATA_ENABLED=true', async () => {
    process.env['CANONICAL_METADATA_ENABLED'] = 'true';
    const legacyService = module.get(LegacyMetadataService);
    const canonicalService = module.get<CanonicalMetadataResolver>(
      CANONICAL_METADATA_SERVICE,
    );

    const mockCanonicalResolved = {
      query: '10.1234/test',
      queryType: 'DOI' as any,
      canonicalId: 'doi:10.1234/test',
      metadata: {
        title: 'Canonical Delegated Paper',
        authors: ['Author X'],
        year: 2024,
        doi: '10.1234/test',
        provenance: {
          originProvider: 'CrossRef',
          resolvedAt: new Date().toISOString(),
          canonicalId: 'doi:10.1234/test',
          confidenceScore: 0.99,
          isOpenAccess: false,
        },
      },
      provenance: {},
      resolvedAt: new Date().toISOString(),
      policyVersion: 1,
    };

    jest
      .spyOn(canonicalService, 'resolve')
      .mockResolvedValue(mockCanonicalResolved);

    const res = await legacyService.resolve('10.1234/test');
    expect(canonicalService.resolve).toHaveBeenCalledWith({
      query: '10.1234/test',
    });
    expect(res?.metadata.title).toBe('Canonical Delegated Paper');
    expect(res?.provider).toBe('CrossRef');

    delete process.env['CANONICAL_METADATA_ENABLED'];
  });

  it('Legacy MetadataService does NOT delegate when CANONICAL_METADATA_ENABLED is false', async () => {
    process.env['CANONICAL_METADATA_ENABLED'] = 'false';
    const legacyService = module.get(LegacyMetadataService);
    const canonicalService = module.get<CanonicalMetadataResolver>(
      CANONICAL_METADATA_SERVICE,
    );

    jest.spyOn(canonicalService, 'resolve');

    await legacyService.resolve('');
    expect(canonicalService.resolve).not.toHaveBeenCalled();

    delete process.env['CANONICAL_METADATA_ENABLED'];
  });

  it('Legacy MetadataService falls back to legacy on canonical internal runtime failure', async () => {
    process.env['CANONICAL_METADATA_ENABLED'] = 'true';
    const legacyService = module.get(LegacyMetadataService);
    const canonicalService = module.get<CanonicalMetadataResolver>(
      CANONICAL_METADATA_SERVICE,
    );

    jest
      .spyOn(canonicalService, 'resolve')
      .mockRejectedValue(new Error('Internal network error'));
    const doResolveSpy = jest
      .spyOn(legacyService as any, 'doResolve')
      .mockResolvedValue({
        query: '10.1234/test',
        queryType: 'DOI',
        provider: 'CrossRef',
        metadata: { title: 'Legacy Fallback Title' },
      });

    const res = await legacyService.resolve('10.1234/test');
    expect(doResolveSpy).toHaveBeenCalled();
    expect(res?.metadata.title).toBe('Legacy Fallback Title');

    delete process.env['CANONICAL_METADATA_ENABLED'];
  });

  it('Legacy MetadataService does NOT fall back on validation or SSRF security errors', async () => {
    process.env['CANONICAL_METADATA_ENABLED'] = 'true';
    const legacyService = module.get(LegacyMetadataService);
    const canonicalService = module.get<CanonicalMetadataResolver>(
      CANONICAL_METADATA_SERVICE,
    );

    jest
      .spyOn(canonicalService, 'resolve')
      .mockRejectedValue(
        new ConflictException('SSRF Protection: Blocked private IP'),
      );
    const doResolveSpy = jest.spyOn(legacyService as any, 'doResolve');

    await expect(
      legacyService.resolve('http://192.168.1.1/paper'),
    ).rejects.toThrow(ConflictException);
    expect(doResolveSpy).not.toHaveBeenCalled();

    delete process.env['CANONICAL_METADATA_ENABLED'];
  });
});
