import { MetadataService } from '@/modules/library/metadata/metadata.service';
import { SemanticScholarProvider } from '@/modules/library/metadata/providers/semantic-scholar.provider';
import { ArxivProvider } from '@/modules/library/metadata/providers/arxiv.provider';
import { PubmedProvider } from '@/modules/library/metadata/providers/pubmed.provider';
import { OpenlibraryProvider } from '@/modules/library/metadata/providers/openlibrary.provider';
import { OpenAlexProvider } from '@/modules/library/metadata/providers/openalex.provider';
import { UnpaywallProvider } from '@/modules/library/metadata/providers/unpaywall.provider';
import { DoiResolver } from '@/modules/library/citation/resolvers/doi.resolver';
import { BibtexFormatter } from '@/modules/library/citation/formatters/bibtex.formatter';
import { RedisCacheService } from '@/core/cache/redis-cache.service';

describe('MetadataService (Redis Cache-Aside Layer)', () => {
  let service: MetadataService;
  let mockS2: jest.Mocked<SemanticScholarProvider>;
  let mockArxiv: jest.Mocked<ArxivProvider>;
  let mockPubmed: jest.Mocked<PubmedProvider>;
  let mockOpenlibrary: jest.Mocked<OpenlibraryProvider>;
  let mockOpenAlex: jest.Mocked<OpenAlexProvider>;
  let mockUnpaywall: jest.Mocked<UnpaywallProvider>;
  let mockDoiResolver: jest.Mocked<DoiResolver>;
  let mockBibtexFormatter: BibtexFormatter;
  let mockRedis: jest.Mocked<RedisCacheService>;

  beforeEach(() => {
    mockS2 = {
      fetchById: jest.fn(),
      searchByTitle: jest.fn(),
    } as any;

    mockArxiv = {
      fetchById: jest.fn(),
    } as any;

    mockPubmed = {
      fetchByPmid: jest.fn(),
    } as any;

    mockOpenlibrary = {
      fetchByIsbn: jest.fn(),
    } as any;

    mockOpenAlex = {
      fetchByDoi: jest.fn(),
      searchByTitle: jest.fn(),
      transformPayload: jest.fn(),
    } as any;

    mockUnpaywall = {
      resolveOaPdf: jest.fn(),
    } as any;

    mockDoiResolver = {
      cleanDoi: jest.fn((d) => d),
      resolve: jest.fn(),
    } as any;

    mockBibtexFormatter = new BibtexFormatter();

    mockRedis = {
      isReady: jest.fn().mockReturnValue(true),
      get: jest.fn(),
      set: jest.fn(),
    } as any;

    service = new MetadataService(
      mockS2,
      mockArxiv,
      mockPubmed,
      mockOpenlibrary,
      mockOpenAlex,
      mockUnpaywall,
      mockDoiResolver,
      mockBibtexFormatter,
      mockRedis,
    );
  });

  it('should return cached result from Redis without hitting external providers (Cache HIT)', async () => {
    const cachedPayload = {
      query: '10.1038/nature12345',
      queryType: 'DOI' as const,
      provider: 'CrossRef' as const,
      metadata: {
        title: 'Cached Quantum Paper',
        authors: ['Smith, John'],
        year: 2023,
        doi: '10.1038/nature12345',
        itemType: 'journalArticle',
      },
    };

    mockRedis.get.mockResolvedValueOnce(cachedPayload);

    const result = await service.resolve('10.1038/nature12345');

    expect(result).toBeDefined();
    expect(result?.cached).toBe(true);
    expect(result?.metadata.title).toBe('Cached Quantum Paper');
    expect(mockS2.fetchById).not.toHaveBeenCalled();
    expect(mockDoiResolver.resolve).not.toHaveBeenCalled();
  });

  it('should resolve externally and populate Redis with 7-day TTL on Cache MISS', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockS2.fetchById.mockResolvedValueOnce({
      title: 'Attention Is All You Need',
      authors: ['Vaswani, Ashish'],
      year: 2017,
      arxivId: '1706.03762',
      itemType: 'preprint',
    });

    const result = await service.resolve('1706.03762');

    expect(result).toBeDefined();
    expect(result?.metadata.title).toBe('Attention Is All You Need');
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('academic:resolve:'),
      expect.objectContaining({ query: '1706.03762' }),
      604800,
    );
  });
});
