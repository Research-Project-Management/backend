import { Test, TestingModule } from '@nestjs/testing';
import { ItemsService as CatalogService } from '@/modules/library/items/items.service';
import { ItemsRepository as CatalogRepository } from '@/modules/library/items/items.repository';
import { FileService } from '@/modules/storage/file/file.service';
import { BibtexFormatter } from '@/modules/library/cite/formatters/bibtex.formatter';
import { TranslationService as IngestionService } from '@/modules/library/translation/translation.service';

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
            resolveWorkspaceId: jest.fn().mockResolvedValue('ws-1'),
            resolveUniqueCitationKey: jest
              .fn()
              .mockResolvedValue('vaswani2017attention'),
            findItems: jest.fn(),
            countPapers: jest.fn(),
            findItemById: jest.fn(),
            createItem: jest.fn().mockImplementation((data) =>
              Promise.resolve({
                id: 'p-1',
                title: data.title,
                authors: data.authors || [],
                year: data.year || null,
                citationKey: data.citationKey || 'vaswani2017attention',
                fileUrl: data.fileUrl || '',
                filename: data.filename || '',
                uploadedBy: {
                  id: 'user-1',
                  name: 'Alice',
                  email: 'alice@test.com',
                  avatar: null,
                },
                collection: null,
              }),
            ),
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
            ingest: jest.fn().mockImplementation((_userId, dto) =>
              Promise.resolve({
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
              }),
            ),
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
});
