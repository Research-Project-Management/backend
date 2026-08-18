import { Test, TestingModule } from '@nestjs/testing';
import { IngestionService } from '@/modules/library/ingestion/ingestion.service';
import { PaperRepository } from '@/modules/library/paper/paper.repository';
import { BibtexFormatter } from '@/modules/library/reference/formatters/bibtex.formatter';
import { DoiResolver } from '@/modules/library/reference/resolvers/doi.resolver';
import { IngestionSourceType } from '@/modules/library/ingestion/dto/ingestion.dto';

describe('IngestionService', () => {
  let service: IngestionService;
  let paperRepo: PaperRepository;
  let doiResolver: DoiResolver;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionService,
        {
          provide: PaperRepository,
          useValue: {
            resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
            createPaper: jest.fn(),
          },
        },
        {
          provide: BibtexFormatter,
          useValue: {
            generateCitationKey: jest.fn().mockReturnValue('Doe2026'),
          },
        },
        {
          provide: DoiResolver,
          useValue: {
            resolve: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<IngestionService>(IngestionService);
    paperRepo = module.get<PaperRepository>(PaperRepository);
    doiResolver = module.get<DoiResolver>(DoiResolver);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should ingest document via DOI', async () => {
    (doiResolver.resolve as jest.Mock).mockResolvedValue({
      title: 'Deep Learning Review',
      authors: ['John Doe'],
      year: 2026,
      doi: '10.1000/182',
    });
    (paperRepo.createPaper as jest.Mock).mockResolvedValue({
      id: 'paper-1',
      title: 'Deep Learning Review',
      authors: ['John Doe'],
      year: 2026,
      doi: '10.1000/182',
      citationKey: 'Doe2026',
      ragStatus: 'indexed',
    });

    const result = await service.ingest('user-1', {
      workspaceId: 'ws-1',
      sourceType: IngestionSourceType.DOI,
      doi: '10.1000/182',
    });

    expect(result.id).toBe('paper-1');
    expect(result.citationKey).toBe('Doe2026');
  });
});
