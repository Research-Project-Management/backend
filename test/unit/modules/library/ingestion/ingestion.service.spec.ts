import { Test, TestingModule } from '@nestjs/testing';
import { IngestionService } from '@/modules/library/ingestion/ingestion.service';
import { PaperRepository } from '@/modules/library/paper/paper.repository';
import { BibtexFormatter } from '@/modules/library/reference/formatters/bibtex.formatter';
import { BibtexParser } from '@/modules/library/reference/parsers/bibtex.parser';
import { RisFormatter } from '@/modules/library/reference/formatters/ris.formatter';
import { DoiResolver } from '@/modules/library/reference/resolvers/doi.resolver';
import { UnifiedFetcherService } from '@/modules/library/reference/fetchers/unified-fetcher.service';
import { IngestionSourceType } from '@/modules/library/ingestion/dto/ingestion.dto';

describe('Seam 1: IngestionService (Universal Ingestion Engine)', () => {
  let service: IngestionService;
  let paperRepo: PaperRepository;
  let bibtexParser: BibtexParser;
  let risFormatter: RisFormatter;
  let unifiedFetcher: UnifiedFetcherService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionService,
        {
          provide: PaperRepository,
          useValue: {
            resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
            resolveUniqueCitationKey: jest
              .fn()
              .mockImplementation((wsId, baseKey) => Promise.resolve(baseKey)),
            createPaper: jest.fn().mockImplementation((data) =>
              Promise.resolve({
                id: 'paper-auto-id',
                ...data,
                ragStatus: 'indexed',
              }),
            ),
          },
        },
        {
          provide: BibtexFormatter,
          useValue: {
            generateCitationKey: jest
              .fn()
              .mockImplementation((title, authors = [], year) => {
                const author = authors[0]?.split(',')[0]?.split(' ').pop() || 'item';
                return `${author.toLowerCase()}${year || 'nd'}${title.slice(0, 5).toLowerCase()}`;
              }),
          },
        },
        {
          provide: BibtexParser,
          useValue: {
            parse: jest.fn(),
          },
        },
        {
          provide: RisFormatter,
          useValue: {
            parse: jest.fn(),
          },
        },
        {
          provide: DoiResolver,
          useValue: {
            resolve: jest.fn(),
          },
        },
        {
          provide: UnifiedFetcherService,
          useValue: {
            resolve: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<IngestionService>(IngestionService);
    paperRepo = module.get<PaperRepository>(PaperRepository);
    bibtexParser = module.get<BibtexParser>(BibtexParser);
    risFormatter = module.get<RisFormatter>(RisFormatter);
    unifiedFetcher = module.get<UnifiedFetcherService>(UnifiedFetcherService);
  });

  describe('Vertical Slice 1.1: Academic Identifier Resolution (DOI, arXiv, PubMed, URL)', () => {
    it('should resolve metadata from DOI and persist normalized paper', async () => {
      (unifiedFetcher.resolve as jest.Mock).mockResolvedValue({
        metadata: {
          title: 'Attention Is All You Need',
          authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
          year: 2017,
          doi: '10.5555/3295222.3295349',
          journal: 'NeurIPS',
          abstract: 'The dominant sequence transduction models...',
          citationKey: 'vaswani2017atten',
        },
        provider: 'semanticscholar',
      });

      const result = await service.ingest('user-1', {
        workspaceId: 'ws-1',
        sourceType: IngestionSourceType.DOI,
        doi: '10.5555/3295222.3295349',
      });

      expect(result.title).toBe('Attention Is All You Need');
      expect(result.doi).toBe('10.5555/3295222.3295349');
      expect(result.authors).toEqual(['Vaswani, Ashish', 'Shazeer, Noam']);
      expect(result.year).toBe(2017);
      expect(paperRepo.createPaper).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-1',
          title: 'Attention Is All You Need',
          journal: 'NeurIPS',
        }),
      );
    });

    it('should resolve metadata from arXiv query string and attach direct PDF URL if available', async () => {
      (unifiedFetcher.resolve as jest.Mock).mockResolvedValue({
        metadata: {
          title: 'Deep Residual Learning for Image Recognition',
          authors: ['He, Kaiming', 'Zhang, Xiangyu'],
          year: 2015,
          doi: '10.48550/arXiv.1512.03385',
          url: 'https://arxiv.org/abs/1512.03385',
          openAccessPdfUrl: 'https://arxiv.org/pdf/1512.03385.pdf',
        },
        provider: 'arxiv',
      });

      const result = await service.ingest('user-1', {
        workspaceId: 'ws-1',
        sourceType: IngestionSourceType.IDENTIFIER,
        query: 'arXiv:1512.03385',
      });

      expect(result.title).toBe('Deep Residual Learning for Image Recognition');
      expect(result.fileUrl).toBe('https://arxiv.org/pdf/1512.03385.pdf');
      expect(result.year).toBe(2015);
    });
  });

  describe('Vertical Slice 1.2: Raw Structured Payload Ingestion (BibTeX & RIS)', () => {
    it('should ingest and parse raw BibTeX text string into paper record', async () => {
      (bibtexParser.parse as jest.Mock).mockReturnValue([
        {
          title: 'Language Models are Few-Shot Learners',
          authors: ['Brown, Tom', 'Mann, Benjamin'],
          year: 2020,
          journal: 'NeurIPS',
          citationKey: 'brown2020language',
          abstract: 'We demonstrate that scaling up language models...',
        },
      ]);

      const result = await service.ingest('user-1', {
        workspaceId: 'ws-1',
        sourceType: IngestionSourceType.BIBTEX,
        bibtex: `@article{brown2020language, title={Language Models are Few-Shot Learners}, author={Brown, Tom and Mann, Benjamin}, year={2020}}`,
      });

      expect(result.title).toBe('Language Models are Few-Shot Learners');
      expect(result.citationKey).toBe('brown2020language');
      expect(result.year).toBe(2020);
    });

    it('should ingest and parse raw RIS payload into paper record', async () => {
      (risFormatter.parse as jest.Mock).mockReturnValue([
        {
          title: 'BERT: Pre-training of Deep Bidirectional Transformers',
          authors: ['Devlin, Jacob', 'Chang, Ming-Wei'],
          year: 2019,
          journal: 'NAACL-HLT',
          doi: '10.18653/v1/N19-1423',
        },
      ]);

      const result = await service.ingest('user-1', {
        workspaceId: 'ws-1',
        sourceType: IngestionSourceType.RIS,
        ris: `TY  - JOUR\nTI  - BERT: Pre-training of Deep Bidirectional Transformers\nER  - `,
      });

      expect(result.title).toBe('BERT: Pre-training of Deep Bidirectional Transformers');
      expect(result.year).toBe(2019);
      expect(result.doi).toBe('10.18653/v1/N19-1423');
    });
  });

  describe('Vertical Slice 1.3: Deterministic Citation Key Resolution & Deduplication', () => {
    it('should preserve explicit custom citationKey if supplied by user', async () => {
      const result = await service.ingest('user-1', {
        workspaceId: 'ws-1',
        sourceType: IngestionSourceType.MANUAL,
        title: 'Custom Algorithm Study',
        citationKey: 'MyCustomKey2026',
      });

      expect(result.citationKey).toBe('MyCustomKey2026');
    });

    it('should invoke resolveUniqueCitationKey to avoid workspace collisions', async () => {
      (paperRepo.resolveUniqueCitationKey as jest.Mock).mockResolvedValue('vaswani2017attenb');

      const result = await service.ingest('user-1', {
        workspaceId: 'ws-1',
        sourceType: IngestionSourceType.MANUAL,
        title: 'Attention Study Replication',
        authors: ['Vaswani, Ashish'],
        year: 2017,
      });

      expect(paperRepo.resolveUniqueCitationKey).toHaveBeenCalledWith(
        'ws-1',
        expect.any(String),
      );
      expect(result.citationKey).toBe('vaswani2017attenb');
    });
  });

  describe('Vertical Slice 1.4: Resilient Fallback Handling', () => {
    it('should gracefully fallback to default title when external resolver fails', async () => {
      (unifiedFetcher.resolve as jest.Mock).mockResolvedValue(null);

      const result = await service.ingest('user-1', {
        workspaceId: 'ws-1',
        sourceType: IngestionSourceType.IDENTIFIER,
        query: 'unknown-query-that-fails-all-providers',
      });

      expect(result.title).toBe('unknown-query-that-fails-all-providers');
      expect(result.id).toBeDefined();
    });
  });
});
