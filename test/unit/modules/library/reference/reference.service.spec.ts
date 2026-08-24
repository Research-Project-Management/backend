import { Test, TestingModule } from '@nestjs/testing';
import { ReferenceService } from '@/modules/library/reference/reference.service';
import { BibtexFormatter } from '@/modules/library/reference/formatters/bibtex.formatter';
import { DoiResolver } from '@/modules/library/reference/resolvers/doi.resolver';
import { PaperRepository } from '@/modules/library/paper/paper.repository';
import { BibtexParser } from '@/modules/library/reference/parsers/bibtex.parser';
import { UnifiedFetcherService } from '@/modules/library/reference/fetchers/unified-fetcher.service';
import { CslFormatter } from '@/modules/library/reference/formatters/csl.formatter';
import { RisFormatter } from '@/modules/library/reference/formatters/ris.formatter';
import { IngestionService } from '@/modules/library/ingestion/ingestion.service';

describe('Seam 3: ReferenceService & Formatters (Citations, BibTeX, RIS)', () => {
  let service: ReferenceService;
  let formatter: BibtexFormatter;
  let paperRepo: PaperRepository;

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
    createPaper: jest.fn(),
    findPapers: jest.fn(),
    findPaperById: jest.fn(),
  };

  const mockIngestionService = {
    ingest: jest.fn().mockImplementation(async (userId, dto) => ({
      id: 'ref-123',
      title: dto.title,
      citationKey: dto.citationKey || 'goldreich2001foundations',
      paper: {
        id: 'ref-123',
        title: dto.title,
        authors: dto.authors || [],
        year: dto.year || null,
        citationKey: dto.citationKey || 'goldreich2001foundations',
        doi: dto.doi || '',
        uploadedBy: {
          id: 'u-1',
          name: 'Alice',
          email: 'alice@test.com',
          avatar: null,
        },
        collection: null,
      },
    })),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferenceService,
        BibtexFormatter,
        CslFormatter,
        RisFormatter,
        BibtexParser,
        DoiResolver,
        {
          provide: UnifiedFetcherService,
          useValue: { resolve: jest.fn() },
        },
        { provide: PaperRepository, useValue: mockPaperRepo },
        { provide: IngestionService, useValue: mockIngestionService },
      ],
    }).compile();

    service = module.get<ReferenceService>(ReferenceService);
    formatter = module.get<BibtexFormatter>(BibtexFormatter);
    paperRepo = module.get<PaperRepository>(PaperRepository);
  });

  describe('Vertical Slice 3.1: CSL Formatter Multi-Style Generation', () => {
    it('should format paper into APA style via formatPaperCitation', async () => {
      mockPaperRepo.findPaperById.mockResolvedValue(mockPaper);

      const res = await service.formatPaperCitation('ws-1', 'paper-1', 'apa');

      expect(res.style).toBe('apa');
      expect(res.inText).toBe('(Vaswani & Shazeer, 2017)');
      expect(res.bibliography).toContain('Vaswani, A. & Shazeer, N. (2017). Attention Is All You Need.');
    });

    it('should format batch papers into IEEE numbered citations', async () => {
      mockPaperRepo.findPapers.mockResolvedValue([mockPaper]);

      const res = await service.formatBatchCitations('ws-1', {
        paperIds: ['paper-1'],
        style: 'ieee',
      });

      expect(res.style).toBe('ieee');
      expect(res.total).toBe(1);
      expect(res.entries[0].inText).toBe('[1]');
    });
  });

  describe('Vertical Slice 3.2: BibTeX & RIS Export', () => {
    it('should format a single paper into clean BibTeX with TeX escaping', () => {
      const bib = formatter.formatEntry({
        title: 'Deep Residual Learning & 100% Accuracy',
        authors: ['He, Kaiming', 'Zhang, Xiangyu'],
        year: 2016,
        journal: 'CVPR & IEEE',
        citationKey: 'he2016deep',
      });

      expect(bib).toContain('@article{he2016deep,');
      expect(bib).toContain(
        'title = {Deep Residual Learning \\& 100\\% Accuracy},',
      );
      expect(bib).toContain('author = {He, Kaiming and Zhang, Xiangyu},');
      expect(bib).toContain('year = {2016},');
    });

    it('should export paper into formatted RIS record via exportRis', async () => {
      mockPaperRepo.findPaperById.mockResolvedValue(mockPaper);

      const res = await service.exportRis('ws-1', 'paper-1');

      expect(res.filename).toBe('vaswani2017attention.ris');
      expect(res.ris).toContain('TY  - JOUR');
      expect(res.ris).toContain('TI  - Attention Is All You Need');
      expect(res.ris).toContain('ER  -');
    });

    it('should export all workspace references as a single .bib payload', async () => {
      mockPaperRepo.findPapers.mockResolvedValue([
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

  describe('Vertical Slice 3.3: Reference Creation Delegation', () => {
    it('should delegate reference creation to IngestionService.ingest', async () => {
      const result = await service.createReference('ws-1', 'u-1', {
        title: 'Foundations of Modern Cryptography',
        authors: ['Goldreich, Oded'],
        year: 2001,
        doi: '10.1017/CBO9780511546891',
      });

      expect(result.reference?.id).toBe('ref-123');
      expect(mockIngestionService.ingest).toHaveBeenCalledWith(
        'u-1',
        expect.objectContaining({
          title: 'Foundations of Modern Cryptography',
          workspaceId: 'ws-1',
        }),
      );
    });
  });
});
