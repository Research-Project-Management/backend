import { BadRequestException } from '@nestjs/common';
import { CitationService } from '@/modules/library/citation/services/citation.service';
import {
  CslStyleRegistry,
  SUPPORTED_CITATION_STYLES,
} from '@/modules/library/citation/domain/citation.domain';
import { CitationItemInput } from '@/modules/library/citation/types/citation.types';
import { CslRepositoryService } from '@/modules/library/citation/services/csl-repository.service';
import { ExportsRepository } from '@/modules/library/citation/repositories/exports.repository';

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

  describe('Custom CSL style spaceId attribution (Project & Personal)', () => {
    const PROJECT_SPACE_ID = '11111111-1111-4111-8111-111111111111';
    const ACTOR_USER_ID = '22222222-2222-4222-8222-222222222222';
    const SAMPLE_CSL_XML = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
  <info>
    <title>Custom Lab Journal Style</title>
    <id>http://www.zotero.org/styles/custom-lab-journal-style</id>
  </info>
  <citation><layout><text variable="title"/></layout></citation>
  <bibliography><layout><text variable="title"/></layout></bibliography>
</style>`;

    it('persists project custom CSL style under canonical project spaceId (not actorUserId)', async () => {
      const mockPrisma = {
        citationStyle: {
          upsert: jest.fn().mockResolvedValue({ id: 'style-1' }),
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };
      const exportsRepo = new ExportsRepository(mockPrisma as never);
      const cslRepo = new CslRepositoryService(
        undefined,
        undefined,
        exportsRepo,
      );

      const meta = await cslRepo.registerCustomStyle(
        SAMPLE_CSL_XML,
        'Custom Lab Journal Style',
        PROJECT_SPACE_ID,
        ACTOR_USER_ID,
      );

      expect(meta.id).toBe('custom-lab-journal-style');
      expect(mockPrisma.citationStyle.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            spaceId_slug: {
              spaceId: PROJECT_SPACE_ID,
              slug: 'custom-lab-journal-style',
            },
          },
          create: expect.objectContaining({
            spaceId: PROJECT_SPACE_ID,
            createdById: ACTOR_USER_ID,
            slug: 'custom-lab-journal-style',
          }),
        }),
      );

      await exportsRepo.findCustomStyle(
        PROJECT_SPACE_ID,
        'custom-lab-journal-style',
      );
      expect(mockPrisma.citationStyle.findUnique).toHaveBeenCalledWith({
        where: {
          spaceId_slug: {
            spaceId: PROJECT_SPACE_ID,
            slug: 'custom-lab-journal-style',
          },
        },
      });
    });
  });
});
