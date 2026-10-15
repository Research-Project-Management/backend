import { SemanticScholarProvider } from '@/modules/library/ingestion/providers/semantic-scholar.provider';
import { DomainRateLimiterService } from '@/modules/library/ingestion/services/domain-rate-limiter.service';

describe('SemanticScholarProvider', () => {
  let provider: SemanticScholarProvider;
  let rateLimiter: DomainRateLimiterService;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    rateLimiter = new DomainRateLimiterService();
    rateLimiter.bypassDelay = true;
    provider = new SemanticScholarProvider(rateLimiter);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('declares SemanticScholar capabilities across DOI, ARXIV, PMID, and TITLE', () => {
    expect(provider.id).toBe('SemanticScholar');
    expect(provider.supports('DOI')).toBe(true);
    expect(provider.supports('ARXIV')).toBe(true);
    expect(provider.supports('PMID')).toBe(true);
    expect(provider.supports('TITLE')).toBe(true);
    expect(provider.supports('ISBN')).toBe(false);
  });

  it('resolves paper by DOI with authors, abstract, and open access URL', async () => {
    const mockPaper = {
      paperId: 'dc32a984b651256a8ec282be52310e6bd33d9815',
      title: 'Highly accurate protein structure prediction with AlphaFold',
      year: 2021,
      venue: 'Nature',
      authors: [
        { authorId: '47921134', name: 'J. Jumper' },
        { authorId: '2115604214', name: 'Richard Evans' },
        { authorId: '48987704', name: 'D. Hassabis' },
      ],
      abstract: 'Proteins are essential to life in all organisms.',
      openAccessPdf: {
        url: 'https://www.nature.com/articles/s41586-021-03819-2.pdf',
      },
      externalIds: {
        DOI: '10.1038/s41586-021-03819-2',
        PubMed: '34265844',
      },
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockPaper,
    } as any);

    const result = await provider.resolve({
      query: '10.1038/s41586-021-03819-2',
      queryType: 'DOI',
    });

    expect(result).toBeDefined();
    expect(result!.provider).toBe('SemanticScholar');
    expect(result!.confidence).toBe(0.92);
    expect(result!.metadata.title).toBe(
      'Highly accurate protein structure prediction with AlphaFold',
    );
    expect(result!.metadata.authors).toEqual([
      'J. Jumper',
      'Richard Evans',
      'D. Hassabis',
    ]);
    expect(result!.metadata.year).toBe(2021);
    expect(result!.metadata.journal).toBe('Nature');
    expect(result!.metadata.abstract).toBe(
      'Proteins are essential to life in all organisms.',
    );
    expect(result!.metadata.url).toBe(
      'https://www.nature.com/articles/s41586-021-03819-2.pdf',
    );
    expect(result!.metadata.pmid).toBe('34265844');
  });

  it('resolves paper by title search fallback', async () => {
    const mockSearchResponse = {
      total: 1,
      data: [
        {
          paperId: '12345678',
          title: 'Deep Residual Learning for Image Recognition',
          year: 2016,
          venue: 'CVPR',
          authors: [{ name: 'Kaiming He' }, { name: 'Xiangyu Zhang' }],
          externalIds: {
            DOI: '10.1109/CVPR.2016.90',
            ArXiv: '1512.03385',
          },
        },
      ],
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockSearchResponse,
    } as any);

    const result = await provider.resolve({
      query: 'Deep Residual Learning for Image Recognition',
      queryType: 'TITLE',
    });

    expect(result).toBeDefined();
    expect(result!.metadata.title).toBe(
      'Deep Residual Learning for Image Recognition',
    );
    expect(result!.metadata.authors).toEqual(['Kaiming He', 'Xiangyu Zhang']);
    expect(result!.metadata.arxivId).toBe('1512.03385');
  });

  it('handles 404 or network outage non-fatally', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    } as any);

    const result = await provider.resolve({
      query: '10.9999/not-found',
      queryType: 'DOI',
    });

    expect(result).toBeNull();
  });
});
