import { EuropePmcSearchProvider } from '@/modules/library/ingestion/providers/europe-pmc-search.provider';

describe('EuropePmcSearchProvider', () => {
  let provider: EuropePmcSearchProvider;

  beforeEach(() => {
    provider = new EuropePmcSearchProvider();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isAvailable', () => {
    it('always returns true for public academic mirror', async () => {
      expect(await provider.isAvailable()).toBe(true);
    });
  });

  describe('search', () => {
    it('parses EuropePMC records and maps metadata correctly', async () => {
      const mockEuropePmcPayload = {
        resultList: {
          result: [
            {
              id: '31234567',
              source: 'MED',
              pmid: '31234567',
              doi: '10.1038/s41586-019-1234-5',
              title: 'CRISPR Cas9 Advances',
              authorList: {
                author: [
                  { fullName: 'Jennifer Doudna' },
                  { firstName: 'Emmanuelle', lastName: 'Charpentier' },
                ],
              },
              journalTitle: 'Nature',
              pubYear: '2020',
              isOpenAccess: 'Y',
              fullTextUrlList: {
                fullTextUrl: [
                  {
                    documentStyle: 'pdf',
                    url: 'https://europepmc.org/articles/PMC1234567?pdf=render',
                  },
                ],
              },
            },
          ],
        },
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockEuropePmcPayload,
      } as any);

      const res = await provider.search('CRISPR');
      expect(res.provider).toBe('europepmc');
      expect(res.hits).toHaveLength(1);

      const hit = res.hits[0];
      expect(hit.title).toBe('CRISPR Cas9 Advances');
      expect(hit.doi).toBe('10.1038/s41586-019-1234-5');
      expect(hit.pmid).toBe('31234567');
      expect(hit.authors).toEqual([
        'Jennifer Doudna',
        'Emmanuelle Charpentier',
      ]);
      expect(hit.year).toBe(2020);
      expect(hit.pdfUrl).toBe(
        'https://europepmc.org/articles/PMC1234567?pdf=render',
      );
      expect(hit.sourceEngine).toBe('europepmc');
      // Score: DOI/PMID (+0.4) + Title (+0.3) + Scientific db (+0.2) + Direct PDF (+0.1) = 1.0
      expect(hit.confidenceScore).toBe(1.0);
    });

    it('handles EuropePMC server errors gracefully', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as any);

      const res = await provider.search('query');
      expect(res.statusCode).toBe(500);
      expect(res.hits).toHaveLength(0);
      expect(res.error).toContain('HTTP 500');
    });
  });
});
