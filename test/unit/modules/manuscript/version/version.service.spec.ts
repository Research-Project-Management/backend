import { Test, TestingModule } from '@nestjs/testing';
import { VersionService } from '@/modules/manuscript/version/version.service';
import { VersionRepository } from '@/modules/manuscript/version/version.repository';

describe('VersionService', () => {
  let service: VersionService;
  let repo: VersionRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VersionService,
        {
          provide: VersionRepository,
          useValue: {
            findPageVersions: jest.fn(),
            findVersionById: jest.fn(),
            createVersion: jest.fn(),
            deleteVersion: jest.fn(),
            findPageById: jest.fn(),
            updatePage: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<VersionService>(VersionService);
    repo = module.get<VersionRepository>(VersionRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create version snapshot successfully', async () => {
    (repo.findPageById as jest.Mock).mockResolvedValue({
      id: 'pg-1',
      title: 'Doc Title',
      content: '\\section{Intro}',
    });
    (repo.createVersion as jest.Mock).mockResolvedValue({
      id: 'v-1',
      pageId: 'pg-1',
      title: 'Doc Title',
      content: '\\section{Intro}',
      label: 'Initial Draft',
    });

    const result = await service.createVersion('pg-1', 'user-1', {
      label: 'Initial Draft',
    });

    expect(result.version.label).toBe('Initial Draft');
    expect(result.version.id).toBe('v-1');
  });

  it('should restore version successfully', async () => {
    (repo.findVersionById as jest.Mock).mockResolvedValue({
      id: 'v-1',
      pageId: 'pg-1',
      title: 'Restored Title',
      content: 'Restored Content',
    });
    (repo.updatePage as jest.Mock).mockResolvedValue({
      id: 'pg-1',
      title: 'Restored Title',
      content: 'Restored Content',
    });

    const result = await service.restoreVersion('pg-1', 'v-1');
    expect(result.page.content).toBe('Restored Content');
    expect(result.message).toBe('Version restored successfully');
  });
});
