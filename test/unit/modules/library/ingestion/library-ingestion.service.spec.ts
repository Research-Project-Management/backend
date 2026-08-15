import { Test, TestingModule } from '@nestjs/testing';
import { LibraryIngestionService } from '@/modules/library/ingestion/library-ingestion.service';
import { PaperRepository } from '@/modules/library/paper/paper.repository';
import { BibtexFormatter } from '@/modules/library/reference/formatters/bibtex.formatter';
import { DoiResolver } from '@/modules/library/reference/resolvers/doi.resolver';
import { IngestionSourceType } from '@/modules/library/ingestion/dto/ingestion.dto';
import { RagStatus } from '@prisma/client';

describe('LibraryIngestionService', () => {
  let service: LibraryIngestionService;
  let paperRepo: PaperRepository;
  let doiResolver: DoiResolver;
  let bibtexFormatter: BibtexFormatter;

  const mockPaperRepo = {
    createPaper: jest.fn(),
  };

  const mockDoiResolver = {
    resolve: jest.fn(),
  };

  const mockBibtexFormatter = {
    generateCitationKey: jest.fn().mockReturnValue('vaswani2017attention'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LibraryIngestionService,
        { provide: PaperRepository, useValue: mockPaperRepo },
        { provide: DoiResolver, useValue: mockDoiResolver },
        { provide: BibtexFormatter, useValue: mockBibtexFormatter },
      ],
    }).compile();

    service = module.get<LibraryIngestionService>(LibraryIngestionService);
    paperRepo = module.get<PaperRepository>(PaperRepository);
    doiResolver = module.get<DoiResolver>(DoiResolver);
    bibtexFormatter = module.get<BibtexFormatter>(BibtexFormatter);
  });

  describe('ingest via DOI', () => {
    it('should resolve DOI metadata, generate citation key, and create paper record', async () => {
      mockDoiResolver.resolve.mockResolvedValue({
        doi: '10.1145/3377325.3377498',
        title: 'Attention Is All You Need',
        authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
        year: 2017,
        journal: 'NeurIPS',
        publisher: 'Curran Associates',
        itemType: 'journalArticle',
      });

      mockPaperRepo.createPaper.mockResolvedValue({
        id: 'paper-1',
        workspaceId: 'ws-1',
        title: 'Attention Is All You Need',
        authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
        year: 2017,
        doi: '10.1145/3377325.3377498',
        citationKey: 'vaswani2017attention',
        ragStatus: RagStatus.indexed,
        collectionId: null,
        fileUrl: '',
      });

      const result = await service.ingest('user-1', {
        workspaceId: 'ws-1',
        sourceType: IngestionSourceType.DOI,
        doi: '10.1145/3377325.3377498',
      });

      expect(result.id).toBe('paper-1');
      expect(result.citationKey).toBe('vaswani2017attention');
      expect(result.title).toBe('Attention Is All You Need');
      expect(mockDoiResolver.resolve).toHaveBeenCalledWith(
        '10.1145/3377325.3377498',
      );
    });
  });

  describe('ingest via BibTeX', () => {
    it('should parse BibTeX text, extract fields, and create paper record', async () => {
      const bibtex = `@article{lecun2015deep,
        title={Deep learning},
        author={LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey},
        journal={Nature},
        year={2015}
      }`;

      mockPaperRepo.createPaper.mockResolvedValue({
        id: 'paper-2',
        workspaceId: 'ws-1',
        title: 'Deep learning',
        authors: ['LeCun, Yann', 'Bengio, Yoshua', 'Hinton, Geoffrey'],
        year: 2015,
        doi: '',
        citationKey: 'lecun2015deep',
        ragStatus: RagStatus.indexed,
        collectionId: null,
        fileUrl: '',
      });

      const result = await service.ingest('user-1', {
        workspaceId: 'ws-1',
        sourceType: IngestionSourceType.BIBTEX,
        bibtex,
      });

      expect(result.id).toBe('paper-2');
      expect(result.title).toBe('Deep learning');
      expect(mockPaperRepo.createPaper).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Deep learning',
          year: 2015,
        }),
      );
    });
  });

  describe('ingest via PDF / Storage', () => {
    it('should create paper record with PENDING status for background RAG indexing', async () => {
      mockPaperRepo.createPaper.mockResolvedValue({
        id: 'paper-3',
        workspaceId: 'ws-1',
        title: 'Quantum Advantage with Superconducting Qubits',
        authors: ['Arute, Frank'],
        year: 2019,
        doi: '',
        citationKey: 'arute2019quantum',
        ragStatus: RagStatus.pending,
        collectionId: 'col-1',
        fileUrl: 'https://r2.storage.com/paper3.pdf',
      });

      const result = await service.ingest('user-1', {
        workspaceId: 'ws-1',
        sourceType: IngestionSourceType.PDF,
        title: 'Quantum Advantage with Superconducting Qubits',
        authors: ['Arute, Frank'],
        year: 2019,
        fileUrl: 'https://r2.storage.com/paper3.pdf',
        collectionId: 'col-1',
        triggerRag: true,
      });

      expect(result.id).toBe('paper-3');
      expect(result.ragStatus).toBe('pending');
      expect(result.fileUrl).toBe('https://r2.storage.com/paper3.pdf');
    });
  });

  describe('batchIngest', () => {
    it('should process multiple documents and return aggregate summary', async () => {
      mockPaperRepo.createPaper.mockResolvedValue({
        id: 'paper-batch',
        workspaceId: 'ws-1',
        title: 'Batch Item',
        authors: ['Author A'],
        year: 2024,
        doi: '',
        citationKey: 'author2024batch',
        ragStatus: RagStatus.indexed,
      });

      const result = await service.batchIngest('user-1', {
        items: [
          {
            workspaceId: 'ws-1',
            sourceType: IngestionSourceType.PDF,
            title: 'Batch Item 1',
          },
          {
            workspaceId: 'ws-1',
            sourceType: IngestionSourceType.PDF,
            title: 'Batch Item 2',
          },
        ],
      });

      expect(result.total).toBe(2);
      expect(result.successCount).toBe(2);
      expect(result.failedCount).toBe(0);
      expect(result.successful.length).toBe(2);
    });
  });
});
