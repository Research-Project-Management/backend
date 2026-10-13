import { ExternalSearchComparatorService } from '@/modules/library/ingestion/services/external-search-comparator.service';
import { SearxngSearchProvider } from '@/modules/library/ingestion/providers/searxng.provider';
import { EuropePmcSearchProvider } from '@/modules/library/ingestion/providers/europe-pmc-search.provider';
import { ExternalSearchResult } from '@/modules/library/ingestion/types/external-search.types';

describe('ExternalSearchComparatorService', () => {
  let comparator: ExternalSearchComparatorService;
  let mockSearxng: jest.Mocked<SearxngSearchProvider>;
  let mockEuropePmc: jest.Mocked<EuropePmcSearchProvider>;

  beforeEach(() => {
    mockSearxng = {
      providerName: 'searxng',
      isAvailable: jest.fn().mockResolvedValue(true),
      search: jest.fn(),
    } as any;

    mockEuropePmc = {
      providerName: 'europepmc',
      isAvailable: jest.fn().mockResolvedValue(true),
      search: jest.fn(),
    } as any;

    comparator = new ExternalSearchComparatorService(
      mockSearxng,
      mockEuropePmc,
    );
  });

  describe('compare', () => {
    it('executes side-by-side search and produces comparative metrics', async () => {
      const searxngMockResult: ExternalSearchResult = {
        provider: 'searxng',
        query: 'quantum computing',
        latencyMs: 180,
        isAvailable: true,
        statusCode: 200,
        hits: [
          {
            title: 'Quantum Supremacy',
            url: 'https://nature.com/articles/10.1038/s41586-019-1666-5',
            doi: '10.1038/s41586-019-1666-5',
            confidenceScore: 0.9,
          },
          {
            title: 'Quantum Algorithms Overview',
            url: 'https://arxiv.org/abs/2101.00001',
            arxivId: '2101.00001',
            pdfUrl: 'https://arxiv.org/pdf/2101.00001.pdf',
            confidenceScore: 1.0,
          },
        ],
      };

      const europePmcMockResult: ExternalSearchResult = {
        provider: 'europepmc',
        query: 'quantum computing',
        latencyMs: 250,
        isAvailable: true,
        statusCode: 200,
        hits: [
          {
            title: 'Quantum Computing in Medicine',
            url: 'https://doi.org/10.1016/j.jbi.2020.103456',
            doi: '10.1016/j.jbi.2020.103456',
            confidenceScore: 0.9,
          },
        ],
      };

      mockSearxng.search.mockResolvedValue(searxngMockResult);
      mockEuropePmc.search.mockResolvedValue(europePmcMockResult);

      const report = await comparator.compare('quantum computing');

      expect(report.query).toBe('quantum computing');
      expect(report.providers.searxng).toBeDefined();
      expect(report.providers.europepmc).toBeDefined();

      // Metrics analysis
      const searxngMetric = report.metrics.searxng;
      expect(searxngMetric.hitsCount).toBe(2);
      expect(searxngMetric.doiResolutionRate).toBe(0.5); // 1 out of 2 has DOI
      expect(searxngMetric.pdfDetectionRate).toBe(0.5); // 1 out of 2 has PDF
      expect(searxngMetric.averageConfidence).toBe(0.95); // (0.9 + 1.0) / 2

      // Fastest & Highest Yield
      expect(report.summary.fastestProvider).toBe('searxng'); // 180ms vs 250ms
      expect(report.summary.highestYieldProvider).toBe('searxng'); // 2 hits vs 1
      expect(report.summary.recommendedSource).toBe('searxng');
    });
  });

  describe('search (Resilient Router)', () => {
    it('returns SearXNG results first when available and hits > 0', async () => {
      const searxngHits: ExternalSearchResult = {
        provider: 'searxng',
        query: 'neural networks',
        latencyMs: 150,
        isAvailable: true,
        hits: [{ title: 'Neural Networks 101', url: 'https://arxiv.org/abs/2001.00001', confidenceScore: 0.9 }],
      };
      mockSearxng.search.mockResolvedValue(searxngHits);

      const result = await comparator.search('neural networks');
      expect(result.provider).toBe('searxng');
      expect(mockEuropePmc.search).not.toHaveBeenCalled();
    });

    it('falls back to EuropePMC when SearXNG yields 0 hits', async () => {
      mockSearxng.search.mockResolvedValue({
        provider: 'searxng',
        query: 'rare disease gene',
        latencyMs: 120,
        isAvailable: true,
        hits: [],
      });

      const europePmcHits: ExternalSearchResult = {
        provider: 'europepmc',
        query: 'rare disease gene',
        latencyMs: 200,
        isAvailable: true,
        hits: [{ title: 'Gene Study', url: 'https://doi.org/10.1000/182', doi: '10.1000/182', confidenceScore: 0.9 }],
      };
      mockEuropePmc.search.mockResolvedValue(europePmcHits);

      const result = await comparator.search('rare disease gene');
      expect(result.provider).toBe('europepmc');
      expect(mockEuropePmc.search).toHaveBeenCalled();
    });
  });
});
