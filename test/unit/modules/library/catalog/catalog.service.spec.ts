import { Test, TestingModule } from '@nestjs/testing';
import { CatalogService } from '@/modules/library/catalog/catalog.service';
import { CatalogRepository } from '@/modules/library/catalog/catalog.repository';
import { FileService } from '@/modules/storage/file/file.service';
import { BibtexFormatter } from '@/modules/library/citation/formatters/bibtex.formatter';
import { IngestionService } from '@/modules/library/ingestion/ingestion.service';

describe('CatalogService', () => {
  let service: CatalogService;
  let repo: CatalogRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogService,
        {
          provide: CatalogRepository,
          useValue: {
            prisma: {
              workspace: {
                findFirst: jest.fn().mockResolvedValue({ id: 'ws-1' }),
              },
              user: {
                findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }),
              },
            },
            resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
            resolveUniqueCitationKey: jest
              .fn()
              .mockResolvedValue('vaswani2017attention'),
            findItems: jest.fn(),
            countPapers: jest.fn(),
            findItemById: jest.fn(),
            createPaper: jest.fn(),
            updatePaper: jest.fn(),
            createAttachment: jest.fn(),
            deleteAttachment: jest.fn(),
          },
        },
        {
          provide: FileService,
          useValue: {
            getFile: jest.fn(),
          },
        },
        {
          provide: BibtexFormatter,
          useValue: {
            generateCitationKey: jest
              .fn()
              .mockReturnValue('vaswani2017attention'),
            formatEntry: jest
              .fn()
              .mockReturnValue(
                '@article{he2016deep,\n  title = {Deep Residual Learning}\n}\n',
              ),
          },
        },
        {
          provide: IngestionService,
          useValue: {
            ingest: jest.fn().mockImplementation(async (userId, dto) => ({
              id: 'p-1',
              title: dto.title,
              authors: dto.authors || [],
              year: dto.year || null,
              citationKey: dto.citationKey || 'vaswani2017attention',
              paper: {
                id: 'p-1',
                title: dto.title,
                authors: dto.authors || [],
                year: dto.year || null,
                citationKey: dto.citationKey || 'vaswani2017attention',
              },
            })),
          },
        },
      ],
    }).compile();

    service = module.get<CatalogService>(CatalogService);
    repo = module.get<CatalogRepository>(CatalogRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should upload paper successfully with generated citation key', async () => {
    const result = await service.uploadPaper('ws-1', 'user-1', {
      title: 'Attention is All You Need',
      filename: 'vaswani.pdf',
      fileUrl: 'https://r2.url/vaswani.pdf',
      authors: ['Vaswani', 'Shazeer'],
      year: 2017,
    });

    expect(result.paper?.title).toBe('Attention is All You Need');
    expect(result.paper?.id).toBe('p-1');
  });

  it('should export BibTeX correctly', async () => {
    (repo.findItemById as jest.Mock).mockResolvedValue({
      id: 'p-1',
      title: 'Deep Residual Learning',
      authors: ['He', 'Zhang'],
      year: 2016,
      journal: 'CVPR',
      citationKey: 'he2016deep',
    });

    const bibtex = await service.exportBibtex('p-1');
    expect(bibtex).toContain('@article{he2016deep,');
    expect(bibtex).toContain('title = {Deep Residual Learning}');
  });
});
