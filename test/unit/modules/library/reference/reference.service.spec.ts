import { Test, TestingModule } from '@nestjs/testing';
import { ReferenceService } from '@/modules/library/reference/reference.service';
import { BibtexFormatter } from '@/modules/library/reference/formatters/bibtex.formatter';
import { DoiResolver } from '@/modules/library/reference/resolvers/doi.resolver';
import { PaperRepository } from '@/modules/library/paper/paper.repository';

import { BibtexParser } from '@/modules/library/reference/parsers/bibtex.parser';
import { UnifiedFetcherService } from '@/modules/library/reference/fetchers/unified-fetcher.service';

import { CslFormatter } from '@/modules/library/reference/formatters/csl.formatter';

describe('ReferenceService & BibtexFormatter', () => {
  let service: ReferenceService;
  let formatter: BibtexFormatter;
  let paperRepo: PaperRepository;

  const mockPaperRepo = {
    resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
    createPaper: jest.fn(),
    findPapers: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferenceService,
        BibtexFormatter,
        CslFormatter,
        BibtexParser,
        DoiResolver,
        {
          provide: UnifiedFetcherService,
          useValue: { resolve: jest.fn() },
        },
        { provide: PaperRepository, useValue: mockPaperRepo },
      ],
    }).compile();


    service = module.get<ReferenceService>(ReferenceService);
    formatter = module.get<BibtexFormatter>(BibtexFormatter);
    paperRepo = module.get<PaperRepository>(PaperRepository);
  });

  describe('BibtexFormatter', () => {
    it('should generate a standardized CitationKey', () => {
      const key = formatter.generateCitationKey(
        'Attention Is All You Need',
        ['Vaswani, Ashish', 'Shazeer, Noam'],
        2017,
      );
      expect(key).toBe('vaswani2017attention');
    });

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

    it('should map book itemType to @book', () => {
      const bib = formatter.formatEntry({
        title: 'Designing Data-Intensive Applications',
        authors: ['Kleppmann, Martin'],
        year: 2017,
        itemType: 'book',
        publisher: "O'Reilly Media",
      });

      expect(bib).toContain('@book{');
      expect(bib).toContain("publisher = {O'Reilly Media},");
    });
  });

  describe('ReferenceService.createReference', () => {
    it('should create a reference record without requiring an uploaded file', async () => {
      const mockCreated = {
        id: 'ref-123',
        title: 'Foundations of Modern Cryptography',
        authors: ['Goldreich, Oded'],
        year: 2001,
        citationKey: 'goldreich2001foundations',
        doi: '10.1017/CBO9780511546891',
        uploadedBy: {
          id: 'u-1',
          name: 'Alice',
          email: 'alice@test.com',
          avatar: null,
        },
        collection: null,
      };
      mockPaperRepo.createPaper.mockResolvedValue(mockCreated);

      const result = await service.createReference('ws-1', 'u-1', {
        title: 'Foundations of Modern Cryptography',
        authors: ['Goldreich, Oded'],
        year: 2001,
        doi: '10.1017/CBO9780511546891',
      });

      expect(result.reference.id).toBe('ref-123');
      expect(mockPaperRepo.createPaper).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Foundations of Modern Cryptography',
          citationKey: 'goldreich2001foundations',
          workspaceId: 'ws-1',
          uploadedById: 'u-1',
        }),
      );
    });
  });

  describe('ReferenceService.exportWorkspaceBibtex', () => {
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
});
