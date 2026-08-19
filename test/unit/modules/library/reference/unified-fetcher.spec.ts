import { UnifiedFetcherService } from '@/modules/library/reference/fetchers/unified-fetcher.service';
import { SemanticScholarFetcher } from '@/modules/library/reference/fetchers/semantic-scholar.fetcher';
import { ArxivFetcher } from '@/modules/library/reference/fetchers/arxiv.fetcher';
import { DoiResolver } from '@/modules/library/reference/resolvers/doi.resolver';
import { BibtexFormatter } from '@/modules/library/reference/formatters/bibtex.formatter';

describe('UnifiedFetcherService', () => {
  let service: UnifiedFetcherService;
  let mockS2: jest.Mocked<SemanticScholarFetcher>;
  let mockArxiv: jest.Mocked<ArxivFetcher>;
  let mockDoi: jest.Mocked<DoiResolver>;
  let formatter: BibtexFormatter;

  beforeEach(() => {
    mockS2 = {
      fetchById: jest.fn(),
      searchByTitle: jest.fn(),
    } as any;

    mockArxiv = {
      fetchById: jest.fn(),
    } as any;

    mockDoi = {
      resolve: jest.fn(),
      cleanDoi: jest.fn((d) => d),
    } as any;

    formatter = new BibtexFormatter();

    service = new UnifiedFetcherService(
      mockS2,
      mockArxiv,
      mockDoi,
      formatter,
    );
  });

  it('should resolve arXiv query via SemanticScholar and fallback to direct ArxivFetcher', async () => {
    mockS2.fetchById.mockResolvedValueOnce(null);
    mockArxiv.fetchById.mockResolvedValueOnce({
      title: 'Attention Is All You Need',
      authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
      year: 2017,
      arxivId: '1706.03762',
      itemType: 'preprint',
      openAccessPdfUrl: 'https://arxiv.org/pdf/1706.03762.pdf',
    });

    const result = await service.resolve('1706.03762');

    expect(result).toBeDefined();
    expect(result?.queryType).toBe('ARXIV');
    expect(result?.provider).toBe('Arxiv');
    expect(result?.metadata.title).toBe('Attention Is All You Need');
    expect(result?.metadata.citationKey).toBe('vaswani2017attention');
    expect(result?.metadata.openAccessPdfUrl).toBe('https://arxiv.org/pdf/1706.03762.pdf');
  });

  it('should resolve DOI query via SemanticScholar with rich TLDR', async () => {
    mockS2.fetchById.mockResolvedValueOnce({
      title: 'Deep Residual Learning',
      authors: ['He, Kaiming'],
      year: 2016,
      doi: '10.1109/CVPR.2016.90',
      itemType: 'conferencePaper',
      tldr: 'Residual networks are easier to optimize.',
      citationCount: 180000,
    });

    const result = await service.resolve('10.1109/CVPR.2016.90');

    expect(result).toBeDefined();
    expect(result?.queryType).toBe('DOI');
    expect(result?.provider).toBe('SemanticScholar');
    expect(result?.metadata.tldr).toBe('Residual networks are easier to optimize.');
    expect(result?.metadata.citationKey).toBe('he2016deep');
  });

  it('should resolve DOI fallback to CrossRef when SemanticScholar returns null', async () => {
    mockS2.fetchById.mockResolvedValueOnce(null);
    mockDoi.resolve.mockResolvedValueOnce({
      title: 'Nature Milestone Paper',
      authors: ['Watson, James', 'Crick, Francis'],
      year: 1953,
      doi: '10.1038/171737a0',
      itemType: 'journalArticle',
      journal: 'Nature',
    });

    const result = await service.resolve('10.1038/171737a0');

    expect(result).toBeDefined();
    expect(result?.queryType).toBe('DOI');
    expect(result?.provider).toBe('CrossRef');
    expect(result?.metadata.journal).toBe('Nature');
    expect(result?.metadata.citationKey).toBe('watson1953nature');
  });
});
