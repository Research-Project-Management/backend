import { Test, TestingModule } from '@nestjs/testing';
import { PaperService } from '@/modules/library/paper/paper.service';
import { PaperRepository } from '@/modules/library/paper/paper.repository';
import { FileService } from '@/modules/storage/file/file.service';
import { BibtexFormatter } from '@/modules/library/reference/formatters/bibtex.formatter';

describe('PaperService', () => {
  let service: PaperService;
  let repo: PaperRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperService,
        {
          provide: PaperRepository,
          useValue: {
            prisma: {
              workspace: {
                findFirst: jest.fn().mockResolvedValue({ id: 'ws-1' }),
              },
              user: {
                findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }),
              },
            },
            findPapers: jest.fn(),
            countPapers: jest.fn(),
            findPaperById: jest.fn(),
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
      ],
    }).compile();

    service = module.get<PaperService>(PaperService);
    repo = module.get<PaperRepository>(PaperRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should upload paper successfully with generated citation key', async () => {
    (repo.createPaper as jest.Mock).mockResolvedValue({
      id: 'p-1',
      title: 'Attention is All You Need',
      authors: ['Vaswani', 'Shazeer'],
      year: 2017,
      citationKey: 'vaswani2017attention',
    });

    const result = await service.uploadPaper('ws-1', 'user-1', {
      title: 'Attention is All You Need',
      filename: 'vaswani.pdf',
      fileUrl: 'https://r2.url/vaswani.pdf',
      authors: ['Vaswani', 'Shazeer'],
      year: 2017,
    });

    expect(result.paper.title).toBe('Attention is All You Need');
    expect(result.paper.id).toBe('p-1');
  });

  it('should export BibTeX correctly', async () => {
    (repo.findPaperById as jest.Mock).mockResolvedValue({
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
