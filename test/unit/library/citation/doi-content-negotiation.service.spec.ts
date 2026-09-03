import { DoiContentNegotiationService } from '../../../../src/modules/library/citation/services/doi-content-negotiation.service';

describe('DoiContentNegotiationService (Unit)', () => {
  let service: DoiContentNegotiationService;

  beforeEach(() => {
    service = new DoiContentNegotiationService();
  });

  describe('cleanDoi', () => {
    it('cleans full URLs, doi: prefixes, and handles valid DOI patterns', () => {
      expect(service.cleanDoi('https://doi.org/10.1145/3372278.3390670')).toBe(
        '10.1145/3372278.3390670',
      );
      expect(
        service.cleanDoi('http://dx.doi.org/10.1038/s41586-020-2649-2'),
      ).toBe('10.1038/s41586-020-2649-2');
      expect(service.cleanDoi('doi: 10.1109/CVPR.2018.00116')).toBe(
        '10.1109/CVPR.2018.00116',
      );
      expect(service.cleanDoi('invalid-doi')).toBeNull();
      expect(service.cleanDoi(null)).toBeNull();
      expect(service.cleanDoi(undefined)).toBeNull();
    });
  });

  describe('resolveCitation', () => {
    it('returns null gracefully for invalid DOI without throwing', async () => {
      const result = await service.resolveCitation('invalid-doi');
      expect(result).toBeNull();
    });

    it('returns null gracefully on network failure or timeout', async () => {
      // Mock global fetch failure
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error('Network offline'));

      try {
        const result = await service.resolveCitation('10.1145/3372278.3390670');
        expect(result).toBeNull();
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('returns and caches valid publisher-rendered bibliography', async () => {
      const mockCitation =
        'Preskill, J. (2021). Quantum Computing in the NISQ era and beyond. Quantum, 5, 79.';
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => mockCitation,
      } as any);

      try {
        const res1 = await service.resolveCitation(
          '10.22331/q-2021-02-05-422',
          'apa',
        );
        expect(res1).toBeDefined();
        expect(res1?.bibliography).toBe(mockCitation);
        expect(res1?.source).toBe('publisher');

        // Second call should be served from in-memory cache without calling fetch again
        const res2 = await service.resolveCitation(
          '10.22331/q-2021-02-05-422',
          'apa',
        );
        expect(res2?.bibliography).toBe(mockCitation);
        expect(global.fetch).toHaveBeenCalledTimes(1);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
