import { DblpProvider } from '@/modules/library/ingestion/providers/dblp.provider';
import { DomainRateLimiterService } from '@/modules/library/ingestion/services/domain-rate-limiter.service';

describe('DblpProvider', () => {
  let provider: DblpProvider;
  let rateLimiter: DomainRateLimiterService;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    rateLimiter = new DomainRateLimiterService();
    rateLimiter.bypassDelay = true;
    provider = new DblpProvider(rateLimiter);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('declares DBLP provider capabilities for DOI and TITLE', () => {
    expect(provider.id).toBe('DBLP');
    expect(provider.supports('DOI')).toBe(true);
    expect(provider.supports('TITLE')).toBe(true);
    expect(provider.supports('PMID')).toBe(false);
  });

  it('resolves conference paper from DBLP by DOI query', async () => {
    const mockDblpHit = {
      result: {
        hits: {
          hit: [
            {
              info: {
                title: 'Attention is All you Need.',
                authors: {
                  author: [
                    'Ashish Vaswani 0001',
                    'Noam Shazeer',
                    'Niki Parmar',
                    'Jakob Uszkoreit',
                  ],
                },
                venue: 'NeurIPS',
                year: '2017',
                pages: '5998-6008',
                type: 'Conference and Workshop Papers',
                doi: '10.5555/3295222.3295349',
                ee: 'https://proceedings.neurips.cc/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html',
              },
            },
          ],
        },
      },
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockDblpHit,
    } as any);

    const result = await provider.resolve({
      query: '10.5555/3295222.3295349',
      queryType: 'DOI',
    });

    expect(result).toBeDefined();
    expect(result!.provider).toBe('DBLP');
    expect(result!.confidence).toBe(0.9);
    expect(result!.metadata.title).toBe('Attention is All you Need');
    expect(result!.metadata.itemType).toBe('conferencePaper');
    expect(result!.metadata.authors).toEqual([
      'Ashish Vaswani', // Disambiguation digits stripped
      'Noam Shazeer',
      'Niki Parmar',
      'Jakob Uszkoreit',
    ]);
    expect(result!.metadata.year).toBe(2017);
    expect(result!.metadata.pages).toBe('5998-6008');
    expect(result!.metadata.conferenceName).toBe('NeurIPS');
    expect(result!.metadata.proceedingsTitle).toBe('NeurIPS');
  });

  it('resolves journal article from DBLP by Title search', async () => {
    const mockDblpHit = {
      result: {
        hits: {
          hit: {
            info: {
              title: 'Scikit-learn: Machine Learning in Python.',
              authors: {
                author: { text: 'Fabian Pedregosa' },
              },
              venue: 'J. Mach. Learn. Res.',
              year: '2011',
              volume: '12',
              pages: '2825-2830',
              type: 'Journal Articles',
              doi: '10.5555/1953048.2078195',
            },
          },
        },
      },
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockDblpHit,
    } as any);

    const result = await provider.resolve({
      query: 'Scikit-learn: Machine Learning in Python',
      queryType: 'TITLE',
    });

    expect(result).toBeDefined();
    expect(result!.metadata.title).toBe(
      'Scikit-learn: Machine Learning in Python',
    );
    expect(result!.metadata.itemType).toBe('journalArticle');
    expect(result!.metadata.authors).toEqual(['Fabian Pedregosa']);
    expect(result!.metadata.journal).toBe('J. Mach. Learn. Res.');
    expect(result!.metadata.volume).toBe('12');
  });

  it('gracefully handles network errors and ECONNRESET without throwing', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('read ECONNRESET'));

    const result = await provider.resolve({
      query: 'NonExistentPaper',
      queryType: 'TITLE',
    });

    expect(result).toBeNull();
  });

  it('gracefully handles 404 and empty hit lists', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: { hits: { hit: [] } } }),
    } as any);

    const result = await provider.resolve({
      query: '10.1000/empty-doi',
      queryType: 'DOI',
    });

    expect(result).toBeNull();
  });
});
