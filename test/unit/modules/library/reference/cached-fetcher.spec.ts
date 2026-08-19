import { UnifiedFetcherService } from '@/modules/library/reference/fetchers/unified-fetcher.service';
import { SemanticScholarFetcher } from '@/modules/library/reference/fetchers/semantic-scholar.fetcher';
import { ArxivFetcher } from '@/modules/library/reference/fetchers/arxiv.fetcher';
import { DoiResolver } from '@/modules/library/reference/resolvers/doi.resolver';
import { BibtexFormatter } from '@/modules/library/reference/formatters/bibtex.formatter';
import { RedisCacheService } from '@/core/cache/redis-cache.service';

describe('UnifiedFetcherService (Redis Cache-Aside Layer)', () => {
  let service: UnifiedFetcherService;
  let mockS2: jest.Mocked<SemanticScholarFetcher>;
  let mockArxiv: jest.Mocked<ArxivFetcher>;
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

    service = new UnifiedFetcherService(
      mockS2,
      mockArxiv,
      mockDoiResolver,
      mockBibtexFormatter,
      mockRedis,
    );
  });

  it('should return cached result from Redis without hitting external providers (Cache HIT)', async () => {
    const cachedPayload = {
      query: '10.1038/nature12345',
      queryType: 'DOI',
      provider: 'CrossRef',
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

  it('should call external provider on Cache MISS and populate Redis for 7 days (604,800s)', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockS2.fetchById.mockResolvedValueOnce({
      title: 'Attention Is All You Need',
      authors: ['Vaswani, Ashish'],
      year: 2017,
      doi: '10.48550/arXiv.1706.03762',
      itemType: 'conferencePaper',
    });

    const result = await service.resolve('1706.03762');

    expect(result).toBeDefined();
    expect(result?.metadata.title).toBe('Attention Is All You Need');
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('academic:resolve:'),
      expect.objectContaining({ provider: 'SemanticScholar' }),
      604800,
    );
  });

  it('should gracefully bypass cache if Redis is offline', async () => {
    mockRedis.isReady.mockReturnValue(false);
    mockS2.fetchById.mockResolvedValueOnce({
      title: 'ResNet Paper',
      authors: ['He, Kaiming'],
      year: 2015,
      itemType: 'conferencePaper',
    });

    const result = await service.resolve('1512.03385');

    expect(result).toBeDefined();
    expect(result?.metadata.title).toBe('ResNet Paper');
    expect(mockRedis.get).not.toHaveBeenCalled();
  });
});
