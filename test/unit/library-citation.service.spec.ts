import { BadRequestException } from '@nestjs/common';
import { CitationService } from '@/modules/library/citation/application/services/citation.service';
import {
  CslStyleRegistry,
  SUPPORTED_CITATION_STYLES,
} from '@/modules/library/citation/application/formatters/csl-style-registry';
import { CitationItemInput } from '@/modules/library/citation/domain/types/citation.types';

describe('Library Citation Service & CSL Style Registry', () => {
  let citationService: CitationService;
  let registry: CslStyleRegistry;

  const mockItem: CitationItemInput = {
    id: 'item-1',
    itemType: 'journalArticle',
    title: 'Attention Is All You Need',
    authors: ['Vaswani, Ashish', 'Shazeer, Noam', 'Parmar, Niki'],
    journal: 'Advances in Neural Information Processing Systems',
    year: 2017,
    doi: '10.5555/3295222.3295349',
    citationKey: 'vaswani2017attention',
  };

  beforeEach(() => {
    citationService = new CitationService();
    registry = new CslStyleRegistry();
  });

  describe('CslStyleRegistry', () => {
    it('should list all 9 canonical styles', () => {
      const styles = registry.listStyles();
      expect(styles).toHaveLength(9);
      expect(styles.map((s) => s.id)).toEqual([
        'apa-7th',
        'ieee',
        'nature',
        'bibtex',
        'ris',
        'mla-9th',
        'chicago',
        'harvard',
        'vancouver',
      ]);
    });

    it('should recognize valid styles and aliases', () => {
      expect(registry.has('apa-7th')).toBe(true);
      expect(registry.has('apa')).toBe(true);
      expect(registry.has('ieee')).toBe(true);
      expect(registry.has('bibtex')).toBe(true);
      expect(registry.has('mla')).toBe(true);
      expect(registry.has('chicago-author-date')).toBe(true);
      expect(registry.has('non-existent-style')).toBe(false);
    });

    it('should generate robust emergency fallbacks for different style categories', () => {
      // author-date fallback
      const apaFallback = registry.formatFallback(mockItem, 'apa-7th');
      expect(apaFallback.inText).toContain('Vaswani');
      expect(apaFallback.inText).toContain('2017');
      expect(apaFallback.bibliography).toContain('Attention Is All You Need');

      // numeric fallback
      const ieeeFallback = registry.formatFallback(mockItem, 'ieee', 3);
      expect(ieeeFallback.inText).toBe('[3]');
      expect(ieeeFallback.bibliography).toContain('[3]');

      // raw bibtex fallback
      const bibtexFallback = registry.formatFallback(mockItem, 'bibtex', 1);
      expect(bibtexFallback.inText).toBe('\\cite{vaswani2017attention}');
      expect(bibtexFallback.bibliography).toContain(
        '@article{vaswani2017attention',
      );

      // raw ris fallback
      const risFallback = registry.formatFallback(mockItem, 'ris', 1);
      expect(risFallback.inText).toBe('Attention Is All You Need');
      expect(risFallback.bibliography).toContain('TY  - JOUR');
      expect(risFallback.bibliography).toContain(
        'TI  - Attention Is All You Need',
      );
    });
  });

  describe('CitationService.formatItem', () => {
    it('should format an item using CslEngine (author-date style)', () => {
      const result = citationService.formatItem(mockItem, 'apa-7th');
      expect(result.styleId).toBe('apa-7th');
      expect(result.inText).toBeDefined();
      expect(result.bibliography).toContain('Attention Is All You Need');
      expect(result.source).toBe('csl-engine');
    });

    it('should format an item using IEEE style (numeric citation)', () => {
      const result = citationService.formatItem(mockItem, 'ieee', 1);
      expect(result.styleId).toBe('ieee');
      expect(result.bibliography).toContain('Attention Is All You Need');
    });

    it('should format an item in BibTeX format', () => {
      const result = citationService.formatItem(mockItem, 'bibtex');
      expect(result.styleId).toBe('bibtex');
      expect(result.bibliography).toContain('@');
      expect(result.bibliography).toContain('vaswani2017attention');
      expect(result.bibliography).toContain('Attention');
    });

    it('should format an item in RIS format', () => {
      const result = citationService.formatItem(mockItem, 'ris');
      expect(result.styleId).toBe('ris');
      expect(result.bibliography).toContain('TY  -');
      expect(result.bibliography).toContain('Attention Is All You Need');
    });

    it('should throw BadRequestException on unknown citation style', () => {
      expect(() => {
        citationService.formatItem(mockItem, 'invalid-style-xyz' as any);
      }).toThrow(BadRequestException);
    });
  });

  describe('CitationService.formatBatch', () => {
    it('should format a batch of items with unified bibliography', () => {
      const items: CitationItemInput[] = [
        mockItem,
        {
          id: 'item-2',
          itemType: 'book',
          title: 'Deep Learning',
          authors: ['Goodfellow, Ian', 'Bengio, Yoshua', 'Courville, Aaron'],
          publisher: 'MIT Press',
          year: 2016,
        },
      ];

      const batch = citationService.formatBatch(items, 'apa-7th');
      expect(batch.styleId).toBe('apa-7th');
      expect(batch.citations).toHaveLength(2);
      expect(batch.bibliographyText).toContain('Attention Is All You Need');
      expect(batch.bibliographyText).toContain('Deep Learning');
    });
  });
});
