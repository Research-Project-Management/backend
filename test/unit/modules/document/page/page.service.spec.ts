import { Test, TestingModule } from '@nestjs/testing';
import { PageService } from '@/modules/document/page/page.service';
import { PageRepository } from '@/modules/document/page/page.repository';

describe('PageService', () => {
  let service: PageService;
  let repo: PageRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PageService,
        {
          provide: PageRepository,
          useValue: {
            findWorkspacePages: jest.fn(),
            findProjectPages: jest.fn(),
            findPageById: jest.fn(),
            findChildPages: jest.fn(),
            createPage: jest.fn(),
            updatePage: jest.fn(),
            deletePage: jest.fn(),
            incrementPageView: jest.fn(),
            findProjectWorkspaceId: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PageService>(PageService);
    repo = module.get<PageRepository>(PageRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create page successfully', async () => {
    (repo.createPage as jest.Mock).mockResolvedValue({
      id: 'pg-1',
      title: 'Introduction to Transformers',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      authorId: 'user-1',
    });

    const result = await service.createPage('ws-1', 'proj-1', 'user-1', {
      title: 'Introduction to Transformers',
    });

    expect(result.page.title).toBe('Introduction to Transformers');
    expect(result.page.id).toBe('pg-1');
  });
});
