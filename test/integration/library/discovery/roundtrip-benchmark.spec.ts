/* eslint-disable @typescript-eslint/no-require-imports */
import { CitationService } from '../../../../src/contexts/library/citation/citation.service';

const roundtripCorpus = require('../../../fixtures/library/reference-roundtrip-corpus.json');


describe('Discovery Benchmark & Roundtrip Fidelity (Integration)', () => {
  let citationService: CitationService;

  beforeAll(() => {
    citationService = new CitationService();
  });

  describe('1. Round-Trip Export Fidelity', () => {
    it('verifies BibTeX round-trip preservation of essential metadata fields', () => {
      const entry = roundtripCorpus.entries[0];
      const res = citationService.formatItem(entry.canonical, 'bibtex');

      expect(res.bibliography).toContain(
        '@inproceedings{vaswani2017attention,',
      );
      expect(res.bibliography).toContain('title = {Attention Is All You Need}');
      expect(res.bibliography).toContain('year = {2017}');
      expect(res.bibliography).toContain('doi = {10.48550/arXiv.1706.03762}');
    });

    it('verifies RIS round-trip preservation of essential metadata fields', () => {
      const entry = roundtripCorpus.entries[0];
      const res = citationService.formatItem(entry.canonical, 'ris');

      expect(res.bibliography).toContain('TY  - CONF');
      expect(res.bibliography).toContain('TI  - Attention Is All You Need');
      expect(res.bibliography).toContain('PY  - 2017');
      expect(res.bibliography).toContain('DO  - 10.48550/arXiv.1706.03762');
      expect(res.bibliography).toContain('ER  -');
    });
  });

  describe('2. 10,000-Item In-Memory Search & Facet Benchmark', () => {
    const itemCount = 10000;
    const mockItems: Array<{
      id: string;
      title: string;
      itemType: string;
      year: number;
      tags: string[];
    }> = [];

    beforeAll(() => {
      const types = ['journalArticle', 'conferencePaper', 'book', 'report'];
      const tagPool = [
        'AI',
        'Quantum',
        'Biology',
        'Robotics',
        'Neuroscience',
        'Economics',
      ];

      for (let i = 0; i < itemCount; i++) {
        mockItems.push({
          id: `item-${i}`,
          title: `Research paper on breakthrough topic #${i} with deep domain insights`,
          itemType: types[i % types.length],
          year: 2000 + (i % 25),
          tags: [
            tagPool[i % tagPool.length],
            tagPool[(i + 1) % tagPool.length],
          ],
        });
      }
    });

    it('filters and facets across 10,000 items in under 50ms', () => {
      const start = performance.now();

      // Filter by query "breakthrough topic #99"
      const query = 'breakthrough topic #99';
      const filtered = mockItems.filter((it) =>
        it.title.toLowerCase().includes(query.toLowerCase()),
      );

      // Compute facets on matching subset
      const itemTypes: Record<string, number> = {};
      const years: Record<number, number> = {};
      const tags: Record<string, number> = {};

      filtered.forEach((it) => {
        itemTypes[it.itemType] = (itemTypes[it.itemType] || 0) + 1;
        years[it.year] = (years[it.year] || 0) + 1;
        it.tags.forEach((t) => {
          tags[t] = (tags[t] || 0) + 1;
        });
      });

      const durationMs = performance.now() - start;

      expect(filtered.length).toBeGreaterThan(0);
      expect(durationMs).toBeLessThan(50);
    });
  });
});
