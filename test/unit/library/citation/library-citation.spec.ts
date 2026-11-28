import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { CitationService } from '@/modules/library/citation/services/citation.service';
import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';
import { CslRepositoryService } from '@/modules/library/citation/services/csl-repository.service';
import { DoiContentNegotiationService } from '@/modules/library/citation/services/doi-negotiation.service';
import { ExportsService } from '@/modules/library/citation/services/exports.service';
import { PdfBakerService } from '@/modules/library/citation/services/pdf-baker.service';
import { CitationFacade } from '@/modules/library/citation/services/citation.facade';
import { ExportsRepository } from '@/modules/library/citation/repositories/exports.repository';
import {
  CslStyleRegistry,
  extractItemCitationAliases,
  resolveEmittedCitationEntries,
} from '@/modules/library/citation/domain/citation.domain';
import {
  resolveExportFormatStrategy,
  formatItemsAsBibtex,
} from '@/modules/library/citation/domain/export-format.mapper';
import { CitationItemInput } from '@/modules/library/citation/types/citation.types';
import { LibraryFacade } from '@/modules/library/library.module';
import { ResilienceRegistryService } from '@/modules/library/core';

describe('Library Citation — Formatting, Styles, Exports, PDF Baking & DOI Negotiation', () => {
  let citationService: CitationService;
  let cslEngine: CslEngineService;
  let styleRegistry: CslStyleRegistry;

  const sampleItem: CitationItemInput = {
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
    citationService = new CitationService(undefined, cslEngine);
    styleRegistry = new CslStyleRegistry();
  });

  describe('CslStyleRegistry & CitationService Formatting', () => {
    it('lists 12 canonical styles, resolves style aliases/categories, and rejects unknown styles', () => {
      const styles = styleRegistry.listStyles();
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
      expect(styleRegistry.has('apa')).toBe(true);
      expect(styleRegistry.has('chicago-author-date')).toBe(true);
      expect(styleRegistry.has('non-existent-style')).toBe(false);
      expect(styleRegistry.getStyle('apa-7th').category).toBe('author-date');
      expect(styleRegistry.getStyle('ieee').category).toBe('numeric');
      expect(styleRegistry.getStyle('bibtex').category).toBe('raw');

      expect(() =>
        citationService.formatItem(sampleItem, 'invalid-style-xyz'),
      ).toThrow(BadRequestException);
    });

    it('formats single and batch citations across APA 7th (with 2024a/2024b disambiguation), IEEE, Vancouver, BibTeX, and RIS', () => {
      expect(citationService.formatItem(sampleItem, 'apa-7th').source).toBe(
        'csl-engine',
      );
      expect(
        citationService.formatItem(sampleItem, 'vancouver').bibliography,
      ).toContain('Attention Is All You Need');
      expect(
        citationService.formatItem(sampleItem, 'bibtex').bibliography,
      ).toContain('vaswani2017attention');
      expect(
        citationService.formatItem(sampleItem, 'ris').bibliography,
      ).toContain('TY  -');

      const itemA: CitationItemInput = {
        id: 'item-2024-a',
        citationKey: 'smith2024alpha',
        itemType: 'journalArticle',
        title: 'Alpha Scaling in Large Language Models',
        year: 2024,
        journal: 'Journal of AI Research',
        volume: '70',
        issue: '1',
        pages: '1-20',
        authors: ['Alice Smith', 'Bob Jones'],
      };
      const itemB: CitationItemInput = {
        id: 'item-2024-b',
        citationKey: 'smith2024beta',
        itemType: 'journalArticle',
        title: 'Beta Alignment in Multimodal Transformers',
        year: 2024,
        journal: 'Journal of AI Research',
        volume: '70',
        issue: '2',
        pages: '21-40',
        authors: ['Alice Smith', 'Bob Jones'],
      };

      const batchApa = citationService.formatBatch([itemA, itemB], 'apa-7th');
      expect(batchApa.citations[0].inText).toContain('2024a');
      expect(batchApa.citations[1].inText).toContain('2024b');
      expect(batchApa.bibliographyText).toContain('2024a');
      expect(batchApa.bibliographyText).toContain('2024b');

      const batchIeee = citationService.formatBatch([itemA, itemB], 'ieee');
      expect(batchIeee.citations[0].inText).toBe('[1]');
      expect(batchIeee.citations[1].inText).toBe('[2]');
    });

    it('persists custom CSL styles under canonical project spaceId while attributing actorUserId', async () => {
      const projectSpaceId = '11111111-1111-4111-8111-111111111111';
      const actorUserId = '22222222-2222-4222-8222-222222222222';
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
        `<?xml version="1.0" encoding="utf-8"?>
        <style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
          <info><title>Custom Lab Journal Style</title><id>http://www.zotero.org/styles/custom-lab-journal-style</id></info>
          <citation><layout><text variable="title"/></layout></citation>
          <bibliography><layout><text variable="title"/></layout></bibliography>
        </style>`,
        'Custom Lab Journal Style',
        projectSpaceId,
        actorUserId,
      );

      expect(meta.id).toBe('custom-lab-journal-style');
      expect(mockPrisma.citationStyle.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            spaceId: projectSpaceId,
            createdById: actorUserId,
            slug: 'custom-lab-journal-style',
          }),
        }),
      );
    });
  });

  describe('ExportsService, Export Strategies & Citation Aliases', () => {
    const mockUserId = 'user-uuid-1111';
    const mockProjectId = 'project-uuid-2222';

    const dbItem1 = {
      id: 'item-uuid-0001',
      itemType: 'journalArticle',
      title: 'Attention Is All You Need',
      publicationTitle: 'Advances in Neural Information Processing Systems',
      year: 2017,
      volume: '30',
      pages: '5998-6008',
      doi: '10.5555/3295222.3295349',
      citationKey: 'vaswani2017attention',
      contributors: [
        {
          firstName: 'Ashish',
          lastName: 'Vaswani',
          role: 'author',
          orderIndex: 0,
        },
        {
          firstName: 'Noam',
          lastName: 'Shazeer',
          role: 'author',
          orderIndex: 1,
        },
      ],
    };

    const dbItemWithoutCiteKey = {
      id: 'raw-uuid-0003',
      itemType: 'journalArticle',
      title: 'Deep Residual Learning for Image Recognition',
      publicationTitle: 'CVPR',
      year: 2016,
      citationKey: null,
      contributors: [
        { firstName: 'Kaiming', lastName: 'He', role: 'author', orderIndex: 0 },
      ],
    };

    it('exports BibTeX by citation keys (case-insensitive, partial matches, UUID fallback, and project membership guard)', async () => {
      const exportsRepo = {
        findItemsByScope: jest
          .fn()
          .mockResolvedValue([dbItem1, dbItemWithoutCiteKey]),
        findProjectMember: jest.fn().mockResolvedValue({ role: 'member' }),
      } as unknown as jest.Mocked<ExportsRepository>;

      const exportsService = new ExportsService(
        exportsRepo,
        citationService,
        new PdfBakerService(),
      );
      const citationFacade = new CitationFacade(
        citationService,
        exportsService,
      );
      const libraryFacade = new LibraryFacade(
        {} as never,
        {} as never,
        {} as never,
        citationFacade,
      );

      expect(await exportsService.exportByCitationKeys(mockUserId, [])).toEqual(
        {
          content: '',
          count: 0,
          foundKeys: [],
          missingKeys: [],
        },
      );

      const partial = await exportsService.exportByCitationKeys(mockUserId, [
        '  VASWANI2017ATTENTION  ',
        'raw-uuid-0003',
        'missing_key_999',
      ]);
      expect(partial.count).toBe(2);
      expect(partial.foundKeys).toEqual([
        'vaswani2017attention',
        'raw-uuid-0003',
      ]);
      expect(partial.missingKeys).toEqual(['missing_key_999']);
      expect(partial.content).toContain('@article{vaswani2017attention,');
      expect(partial.content).toContain('He, Kaiming');

      const scoped = await libraryFacade.exportByCitationKeys(
        mockUserId,
        ['vaswani2017attention'],
        mockProjectId,
      );
      expect(scoped.count).toBe(1);
      expect(exportsRepo.findItemsByScope).toHaveBeenLastCalledWith(
        expect.objectContaining({
          AND: expect.arrayContaining([
            { spaceId: mockProjectId, deletedAt: null },
          ]),
        }),
      );

      exportsRepo.findProjectMember.mockResolvedValueOnce(null);
      await expect(
        exportsService.exportByCitationKeys(
          mockUserId,
          ['vaswani2017attention'],
          'unauthorized-project-id',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('resolves merged citation key aliases (tex.ids) and exports CSV (neutralizing formula injection), BibTeX, RIS, and CSL-JSON', () => {
      const itemWithAliases = {
        id: 'item-merged-1',
        citationKey: 'vaswani2017attention',
        extra:
          'Citation Key: vaswani2017neurips\ntex.ids: vaswani2017arxiv, vaswani2017nips',
        metadata: { mergedCitationKeys: ['vaswani2017old'] },
      };
      expect(extractItemCitationAliases(itemWithAliases)).toEqual(
        expect.arrayContaining([
          'vaswani2017attention',
          'vaswani2017neurips',
          'vaswani2017arxiv',
          'vaswani2017nips',
          'vaswani2017old',
        ]),
      );
      const emitted = resolveEmittedCitationEntries(
        [itemWithAliases],
        ['vaswani2017arxiv'],
      );
      expect(emitted.emittedEntries[0].emitCiteKey).toBe('vaswani2017arxiv');

      const exportItem = {
        id: 'export-1',
        citationKey: 'malicious2024csv',
        itemType: 'journalArticle',
        title: "=cmd|' /C calc'!A0",
        authors: ['World Health Organization', 'Ada Lovelace'],
        contributors: [
          {
            fullName: 'World Health Organization',
            creatorType: 'author',
            fieldMode: 1,
          },
          { firstName: 'Ada', lastName: 'Lovelace', creatorType: 'author' },
        ],
        year: 2024,
        publicationTitle: 'Journal of Security & Testing',
        doi: '10.1000/sec.2024.01',
      };

      expect(
        resolveExportFormatStrategy('csv')!.export([exportItem]).content,
      ).toContain('"\'=cmd|');
      expect(formatItemsAsBibtex([exportItem], citationService)).toContain(
        '{World Health Organization}',
      );
      expect(
        resolveExportFormatStrategy('ris')!.export([exportItem], {
          citationFormatter: citationService,
        }).content,
      ).toContain('DO  - 10.1000/sec.2024.01');
      const cslJson = JSON.parse(
        resolveExportFormatStrategy('csl-json')!.export([exportItem]).content,
      ) as Array<{ DOI?: string }>;
      expect(cslJson[0].DOI).toBe('10.1000/sec.2024.01');
    });
  });

  describe('PdfBakerService & DoiContentNegotiationService', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('burns normalized [0,1] W3C top-left annotations (0-based and 1-based UI pages) onto PDF bottom-left coordinates', async () => {
      const baker = new PdfBakerService();
      const doc = await PDFDocument.create();
      doc.addPage([600, 800]);
      const rawBytes = await doc.save();

      const bakedZeroBased = await baker.burnAnnotationsToPdf(rawBytes, [
        {
          pageIndex: 0,
          type: 'highlight',
          color: '#ffd400',
          comment: 'Important finding',
          rectCoords: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 },
        },
        {
          pageIndex: 0,
          type: 'underline',
          color: '#2ea8e5',
          rectCoords: {
            rects: [{ x: 0.2, y: 0.3, width: 0.4, height: 0.03 }],
          },
        },
      ]);
      expect(bakedZeroBased.byteLength).toBeGreaterThan(rawBytes.byteLength);

      const bakedOneBased = await baker.burnAnnotationsToPdf(rawBytes, [
        {
          pageIndex: 1,
          pageLabel: '1',
          type: 'highlight',
          color: '#ffd400',
          rectCoords: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 },
        },
      ]);
      expect(bakedOneBased.byteLength).toBeGreaterThan(rawBytes.byteLength);
    });

    it('trips doi-org circuit breaker after repeated 503 responses and fast-fails subsequent calls', async () => {
      const resilience = new ResilienceRegistryService();
      resilience.resetAll();
      const doiService = new DoiContentNegotiationService(resilience);

      const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 503 });
      global.fetch = fetchMock as unknown as typeof fetch;

      for (let i = 1; i <= 4; i++) {
        await doiService.resolveCitation(`10.1000/182_fail${i}`);
      }
      expect(resilience.getCircuitBreaker('doi-org').getState()).toBe('OPEN');

      fetchMock.mockClear();
      const fastFailed = await doiService.resolveCitation('10.1000/182_fail5');
      expect(fastFailed).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
