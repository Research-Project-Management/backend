import { BadRequestException } from '@nestjs/common';
import { CitationService } from '@/modules/library/citation/services/citation.service';
import {
  CslStyleRegistry,
  SUPPORTED_CITATION_STYLES,
} from '@/modules/library/citation/domain/citation.domain';
import { CitationItemInput } from '@/modules/library/citation/types/citation.types';

import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';

describe('Library Citation Service & CSL Style Registry', () => {
  let citationService: CitationService;
  let registry: CslStyleRegistry;
  let cslEngine: CslEngineService;

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
    cslEngine = new CslEngineService();
    cslEngine.onModuleInit();
    citationService = new CitationService({} as any, cslEngine, {} as any);
    registry = new CslStyleRegistry();
  });

  describe('CslStyleRegistry', () => {
    it('should list all canonical styles including Vietnamese academic standards', () => {
      const styles = registry.listStyles();
      expect(styles).toHaveLength(12);
      expect(styles.map((s) => s.id)).toEqual([
        'auto',
        'apa-7th',
        'ieee',
        'mla-9th',
        'bibtex',
        'chicago',
        'harvard',
        'nature',
        'vancouver',
        'tcvn',
        'tcvn-numeric',
        'ris',
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

    it('should return style metadata via getStyle', () => {
      const apaStyle = registry.getStyle('apa-7th');
      expect(apaStyle.id).toBe('apa-7th');
      expect(apaStyle.category).toBe('author-date');

      const ieeeStyle = registry.getStyle('ieee');
      expect(ieeeStyle.id).toBe('ieee');
      expect(ieeeStyle.category).toBe('numeric');

      const bibtexStyle = registry.getStyle('bibtex');
      expect(bibtexStyle.id).toBe('bibtex');
      expect(bibtexStyle.category).toBe('raw');
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
        citationService.formatItem(mockItem, 'invalid-style-xyz');
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
