import { SearxngSearchProvider } from '@/modules/library/ingestion/providers/searxng.provider';

describe('SearxngSearchProvider', () => {
  let provider: SearxngSearchProvider;

  beforeEach(() => {
    provider = new SearxngSearchProvider();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isAvailable', () => {
    it('returns true when SearXNG healthz responds 200', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
      } as any);

      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('returns false when SearXNG server is unreachable', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('Connection refused'));

      const available = await provider.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe('search', () => {
    it('parses science results and extracts DOI, arXiv, and computes confidence score', async () => {
      const mockSearxngPayload = {
        query: 'attention is all you need',
        number_of_results: 2,
        results: [
          {
            title: 'Attention Is All You Need',
            url: 'https://arxiv.org/abs/1706.03762',
            content:
              'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks...',
            engine: 'arxiv',
            publishedDate: '2017-06-12',
          },
          {
            title: 'Deep Residual Learning for Image Recognition',
            url: 'https://link.springer.com/article/10.1007/s11263-015-0816-y',
            content: 'Deeper neural networks are more difficult to train...',
            engine: 'google scholar',
            publishedDate: '2015',
          },
        ],
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockSearxngPayload,
      } as any);

      const result = await provider.search('attention is all you need');

      expect(result.provider).toBe('searxng');
      expect(result.statusCode).toBe(200);
      expect(result.isAvailable).toBe(true);
      expect(result.hits).toHaveLength(2);

      // Hit 1: arXiv
      const hit1 = result.hits[0];
      expect(hit1.title).toBe('Attention Is All You Need');
      expect(hit1.arxivId).toBe('1706.03762');
      expect(hit1.pdfUrl).toBe('https://arxiv.org/pdf/1706.03762.pdf');
      expect(hit1.sourceEngine).toBe('arxiv');
      expect(hit1.year).toBe(2017);
      // Score: arXiv ID (+0.4) + Title (+0.3) + Science engine (+0.2) + Direct PDF (+0.1) = 1.0
      expect(hit1.confidenceScore).toBe(1.0);

      // Hit 2: Springer DOI
      const hit2 = result.hits[1];
      expect(hit2.title).toBe('Deep Residual Learning for Image Recognition');
      expect(hit2.doi).toBe('10.1007/s11263-015-0816-y');
      expect(hit2.sourceEngine).toBe('google scholar');
      expect(hit2.year).toBe(2015);
      // Score: DOI (+0.4) + Title (+0.3) + Science engine (+0.2) = 0.9
      expect(hit2.confidenceScore).toBe(0.9);
    });

    it('handles SearXNG error response gracefully', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      } as any);

      const result = await provider.search('query');
      expect(result.statusCode).toBe(503);
      expect(result.hits).toHaveLength(0);
      expect(result.error).toContain('HTTP 503');
    });

    it('handles timeout gracefully without throwing exception', async () => {
      const timeoutError = new Error('The operation was aborted');
      timeoutError.name = 'TimeoutError';
      global.fetch = jest.fn().mockRejectedValue(timeoutError);

      const result = await provider.search('slow query', { timeoutMs: 100 });
      expect(result.isAvailable).toBe(false);
      expect(result.hits).toHaveLength(0);
      expect(result.error).toContain('timeout');
    });
  });
});
