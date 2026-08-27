import { Test, TestingModule } from '@nestjs/testing';
import { CiteService as CitationService } from '@/modules/library/legacy/cite/cite.service';
import { BibtexFormatter } from '@/modules/library/legacy/cite/formatters/bibtex.formatter';
import { DoiResolver } from '@/modules/library/legacy/cite/resolvers/doi.resolver';
import { ItemsRepository as CatalogRepository } from '@/modules/library/legacy/items/items.repository';
import { BibtexParser } from '@/modules/library/legacy/cite/parsers/bibtex.parser';
import { CslFormatter } from '@/modules/library/legacy/cite/formatters/csl.formatter';
import { RisFormatter } from '@/modules/library/legacy/cite/formatters/ris.formatter';
import { MapperService as ReferenceManagerMapperService } from '@/modules/library/legacy/cite/mapper.service';

describe('CitationService & Formatters', () => {
  let service: CitationService;
  let formatter: BibtexFormatter;
  let paperRepo: CatalogRepository;

  const mockPaper = {
    id: 'paper-1',
    workspaceId: 'ws-1',
    title: 'Attention Is All You Need',
    authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
    year: 2017,
    journal: 'NeurIPS',
    volume: '30',
    pages: '5998-6008',
    doi: '10.5555/3295222.3295349',
    citationKey: 'vaswani2017attention',
    deletedAt: null,
  };

  const mockPaperRepo = {
    resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
    resolveWorkspaceId: jest.fn().mockResolvedValue('ws-1'),
    resolveUniqueCitationKey: jest
      .fn()
      .mockResolvedValue('goldreich2001foundations'),
    createItem: jest
      .fn()
      .mockImplementation((data) =>
        Promise.resolve({ id: 'ref-123', ...data }),
      ),
    createPaper: jest.fn(),
    findItems: jest.fn(),
    findItemById: jest.fn(),
    findItemByIdInWorkspace: jest.fn().mockResolvedValue(mockPaper),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CitationService,
        BibtexFormatter,
        BibtexParser,
        DoiResolver,
        CslFormatter,
        RisFormatter,
        ReferenceManagerMapperService,
        {
          provide: CatalogRepository,
          useValue: mockPaperRepo,
        },
      ],
    }).compile();

    service = module.get<CitationService>(CitationService);
    formatter = module.get<BibtexFormatter>(BibtexFormatter);
    paperRepo = module.get<CatalogRepository>(CatalogRepository);
  });

  describe('formatCitation', () => {
    it('should format APA citation for valid catalog paper', async () => {
      const citation = await service.formatCitation('ws-1', 'paper-1', 'apa');

      expect(citation.style).toBe('apa');
      expect(citation.inText).toBe('(Vaswani & Shazeer, 2017)');
      expect(citation.bibliography).toContain('Attention Is All You Need');
      expect(citation.bibliography).toContain('NeurIPS');
    });

    it('should format IEEE citation with numbered format', async () => {
      const citation = await service.formatCitation('ws-1', 'paper-1', 'ieee');

      expect(citation.style).toBe('ieee');
      expect(citation.inText).toBe('[1]');
      expect(citation.bibliography).toContain('A. Vaswani and N. Shazeer');
    });
  });

  describe('formatBatchCitations', () => {
    it('should format multiple citations in single call', async () => {
      mockPaperRepo.findItems.mockResolvedValue([mockPaper]);

      const result = await service.formatBatchCitations('ws-1', {
        itemIds: ['paper-1'],
        style: 'apa',
      });

      expect(result.total).toBe(1);
      expect(result.entries[0].inText).toBe('(Vaswani & Shazeer, 2017)');
    });
  });

  describe('exportWorkspaceBibtex', () => {
    it('should export all items in workspace as single .bib string', async () => {
      mockPaperRepo.findItems.mockResolvedValue([
        {
          title: 'Paper One',
          authors: ['Author A'],
          year: 2021,
          citationKey: 'author2021paper',
        },
        {
          title: 'Paper Two',
          authors: ['Author B'],
          year: 2022,
          citationKey: 'author2022paper',
        },
      ]);

      const result = await service.exportWorkspaceBibtex('ws-1');
      expect(result.total).toBe(2);
      expect(result.filename).toBe('workspace-ws-1.bib');
      expect(result.bibtex).toContain('@article{author2021paper,');
      expect(result.bibtex).toContain('@article{author2022paper,');
    });
  });

  describe('Direct Item Creation from BibTeX', () => {
    it('should create items directly via CatalogRepository', async () => {
      const result = await service.importBibtex('ws-1', 'u-1', {
        bibtex:
          '@article{goldreich2001, title={Foundations of Modern Cryptography}, author={Goldreich, Oded}, year={2001}, doi={10.1017/CBO9780511546891}}',
      });

      expect(result.imported).toBe(1);
      expect(mockPaperRepo.createItem).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Foundations of Modern Cryptography',
          citationKey: 'goldreich2001foundations',
        }),
      );
    });
  });
});
