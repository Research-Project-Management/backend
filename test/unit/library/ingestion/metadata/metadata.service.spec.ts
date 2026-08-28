import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import {
  MetadataService,
} from '@/modules/library/ingestion/metadata/metadata.service';
import {
  CANONICAL_METADATA_PROVIDERS,
  MetadataProvider,
  ProviderResult,
} from '@/modules/library/ingestion/metadata/metadata.contracts';
import { MetadataCache } from '@/modules/library/ingestion/metadata/metadata.cache';
import { MetadataReconciliationService } from '@/modules/library/ingestion/metadata/metadata.reconciler';
import { ProviderExecutor, ProviderFetchError } from '@/modules/library/ingestion/metadata/metadata.executor';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProvider(
  id: string,
  queryTypes: string[],
  result: ProviderResult | null,
): MetadataProvider {
  return {
    id: id as any,
    capabilities: {
      queryTypes: queryTypes as any,
      isAuthoritative: true,
      timeoutMs: 5000,
      maxConcurrency: 2,
    },
    supports: (qt) => queryTypes.includes(qt),
    resolve: jest.fn().mockResolvedValue(result),
  };
}

function makeResult(
  provider: string,
  title: string,
  confidence = 0.95,
): ProviderResult {
  return {
    provider: provider as any,
    metadata: {
      title,
      authors: ['Author A'],
      year: 2024,
      doi: '10.1234/test',
      itemType: 'journalArticle',
    },
    confidence,
    identifier: '10.1234/test',
    fetchedAt: new Date().toISOString(),
  };
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockCache = {
  get: jest.fn() as jest.Mock,
  set: jest.fn() as jest.Mock,
  setNegative: jest.fn() as jest.Mock,
  buildKey: jest.fn().mockReturnValue('test-cache-key') as jest.Mock,
  available: true,
};

const reconcilerResult = {
  metadata: {
    title: 'Test Paper',
    authors: ['Author A'],
    year: 2024,
    doi: '10.1234/test',
    itemType: 'journalArticle',
  },
  assertions: [
    {
      field: 'title',
      value: 'Test Paper',
      sourceProvider: 'CrossRef',
      confidenceScore: 0.99,
      isUserOverride: false,
      timestamp: new Date().toISOString(),
    },
  ],
  candidates: [],
  conflictReport: { hasConflicts: false, conflicts: [] },
  reconciledAt: new Date().toISOString(),
};

const mockReconciler = {
  reconcile: jest.fn().mockReturnValue(reconcilerResult),
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('MetadataService (canonical orchestrator)', () => {
  let service: MetadataService;
  let crossref: MetadataProvider;
  let s2: MetadataProvider;
  let openAlex: MetadataProvider;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCache.get.mockResolvedValue(null);
    mockCache.set.mockResolvedValue(undefined);
    mockCache.setNegative.mockResolvedValue(undefined);
    mockCache.buildKey.mockReturnValue('test-cache-key');

    crossref = makeProvider('CrossRef', ['DOI', 'TITLE'], makeResult('CrossRef', 'Test Paper'));
    s2 = makeProvider('SemanticScholar', ['DOI', 'ARXIV', 'PMID', 'TITLE'], makeResult('SemanticScholar', 'Test Paper', 0.88));
    openAlex = makeProvider('OpenAlex', ['DOI', 'TITLE'], makeResult('OpenAlex', 'Test Paper', 0.85));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetadataService,
        ProviderExecutor,
        { provide: MetadataCache, useValue: mockCache },
        { provide: MetadataReconciliationService, useValue: mockReconciler },
        {
          provide: CANONICAL_METADATA_PROVIDERS,
          useValue: [crossref, s2, openAlex],
        },
      ],
    }).compile();

    service = module.get(MetadataService);
  });

  // ── Input validation ───────────────────────────────────────────────────────
  it('returns null for empty string', async () => {
    expect(await service.resolve({ query: '' })).toBeNull();
  });

  it('returns null for whitespace-only string', async () => {
    expect(await service.resolve({ query: '   ' })).toBeNull();
  });

  // ── Cache hit ──────────────────────────────────────────────────────────────
  it('returns cached result without calling any provider', async () => {
    const cached = { query: '10.1234/test', queryType: 'DOI', cached: true } as any;
    mockCache.get.mockResolvedValue(cached);

    const result = await service.resolve({ query: '10.1234/test' });
    expect(result?.cached).toBe(true);
    expect(crossref.resolve).not.toHaveBeenCalled();
  });

  it('returns null on negative cache hit (false sentinel)', async () => {
    mockCache.get.mockResolvedValue(false);
    const result = await service.resolve({ query: '10.1234/test' });
    expect(result).toBeNull();
    expect(crossref.resolve).not.toHaveBeenCalled();
  });

  // ── forceRefresh ───────────────────────────────────────────────────────────
  it('skips cache read on forceRefresh but still calls set', async () => {
    const stale = { query: 'old', queryType: 'DOI' } as any;
    mockCache.get.mockResolvedValue(stale);

    await service.resolve({ query: '10.1234/test', forceRefresh: true });
    expect(mockCache.get).not.toHaveBeenCalled();
    expect(mockCache.set).toHaveBeenCalled();
  });

  // ── Authoritative resolution ───────────────────────────────────────────────
  it('calls CrossRef for DOI query and returns resolved metadata', async () => {
    const result = await service.resolve({ query: '10.1234/test' });
    expect(crossref.resolve).toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result?.queryType).toBe('DOI');
  });

  // ── Partial provider failure — others succeed ──────────────────────────────
  it('succeeds when one enrichment provider throws', async () => {
    (s2.resolve as jest.Mock).mockRejectedValue(new Error('S2 timeout'));

    const result = await service.resolve({ query: '10.1234/test' });
    expect(crossref.resolve).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  // ── Authoritative miss → fallback ──────────────────────────────────────────
  it('falls back to OpenAlex when CrossRef returns null for DOI', async () => {
    (crossref.resolve as jest.Mock).mockResolvedValue(null);
    (s2.resolve as jest.Mock).mockResolvedValue(null);

    const result = await service.resolve({ query: '10.1234/test' });
    expect(openAlex.resolve).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  // ── All providers miss (pure not_found) → negative cache ────────────────────
  it('sets negative cache when all providers return null (not_found)', async () => {
    (crossref.resolve as jest.Mock).mockResolvedValue(null);
    (s2.resolve as jest.Mock).mockResolvedValue(null);
    (openAlex.resolve as jest.Mock).mockResolvedValue(null);

    const result = await service.resolve({ query: '10.1234/test' });
    expect(result).toBeNull();
    expect(mockCache.setNegative).toHaveBeenCalled();
  });

  // ── Transient error (500/timeout) does NOT negative cache ──────────────────
  it('does NOT set negative cache when provider fails with 500 error or timeout', async () => {
    (crossref.resolve as jest.Mock).mockRejectedValue(
      new ProviderFetchError('Internal Server Error', 500),
    );
    (s2.resolve as jest.Mock).mockResolvedValue(null);
    (openAlex.resolve as jest.Mock).mockResolvedValue(null);

    const result = await service.resolve({ query: '10.1234/test' });
    expect(result).toBeNull();
    expect(mockCache.setNegative).not.toHaveBeenCalled();
  });

  it('does NOT set negative cache on configuration_error (401/403)', async () => {
    (crossref.resolve as jest.Mock).mockRejectedValue(
      new ProviderFetchError('Unauthorized API key', 401),
    );
    (s2.resolve as jest.Mock).mockResolvedValue(null);
    (openAlex.resolve as jest.Mock).mockResolvedValue(null);

    const result = await service.resolve({ query: '10.1234/test' });
    expect(result).toBeNull();
    expect(mockCache.setNegative).not.toHaveBeenCalled();
  });

  it('does NOT set negative cache on invalid_payload (400 / SyntaxError)', async () => {
    (crossref.resolve as jest.Mock).mockRejectedValue(
      new ProviderFetchError('Malformed JSON payload', 400),
    );
    (s2.resolve as jest.Mock).mockResolvedValue(null);
    (openAlex.resolve as jest.Mock).mockResolvedValue(null);

    const result = await service.resolve({ query: '10.1234/test' });
    expect(result).toBeNull();
    expect(mockCache.setNegative).not.toHaveBeenCalled();
  });

  it('does NOT set negative cache when no provider is supported or configured for query', async () => {
    const emptyModule: TestingModule = await Test.createTestingModule({
      providers: [
        MetadataService,
        ProviderExecutor,
        { provide: MetadataCache, useValue: mockCache },
        { provide: MetadataReconciliationService, useValue: mockReconciler },
        { provide: CANONICAL_METADATA_PROVIDERS, useValue: [] },
      ],
    }).compile();

    const emptySvc = emptyModule.get(MetadataService);
    const result = await emptySvc.resolve({ query: '10.1234/test' });
    expect(result).toBeNull();
    expect(mockCache.setNegative).not.toHaveBeenCalled();
  });

  // ── SSRF guard ─────────────────────────────────────────────────────────────
  it('throws ConflictException for private IP URL', async () => {
    await expect(
      service.resolve({ query: 'http://192.168.1.1/secret' }),
    ).rejects.toThrow(ConflictException);
    expect(crossref.resolve).not.toHaveBeenCalled();
  });

  it('throws ConflictException for localhost URL', async () => {
    await expect(
      service.resolve({ query: 'http://localhost:8080/admin' }),
    ).rejects.toThrow(ConflictException);
  });

  // ── URL with embedded DOI ──────────────────────────────────────────────────
  it('re-resolves DOI embedded in public doi.org URL', async () => {
    const result = await service.resolve({
      query: 'https://doi.org/10.1234/test',
    });
    expect(result?.queryType).toBe('DOI');
  });

  // ── arXiv URL ─────────────────────────────────────────────────────────────
  it('re-resolves arXiv embedded in arxiv.org URL', async () => {
    const arxiv = makeProvider('arXiv', ['ARXIV'], makeResult('arXiv', 'Attention Is All You Need'));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetadataService,
        ProviderExecutor,
        { provide: MetadataCache, useValue: mockCache },
        { provide: MetadataReconciliationService, useValue: mockReconciler },
        { provide: CANONICAL_METADATA_PROVIDERS, useValue: [arxiv, s2, openAlex] },
      ],
    }).compile();

    const svc = module.get(MetadataService);
    await svc.resolve({ query: 'https://arxiv.org/abs/1706.03762' });
    expect(arxiv.resolve).toHaveBeenCalled();
  });
});
