import { Test, TestingModule } from '@nestjs/testing';
import { HistoryService } from '@/modules/document/history/history.service';
import { HistoryRepository } from '@/modules/document/history/history.repository';

describe('HistoryService', () => {
  let service: HistoryService;
  let repo: HistoryRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HistoryService,
        {
          provide: HistoryRepository,
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

    service = module.get<HistoryService>(HistoryService);
    repo = module.get<HistoryRepository>(HistoryRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should get version history for a page', async () => {
    (repo.findPageVersions as jest.Mock).mockResolvedValue([
      { id: 'v-1', title: 'Draft v1', pageId: 'p-1' },
    ]);

    const result = await service.getHistory('p-1');
    expect(result.history.length).toBe(1);
  });

  it('should get versions list for a page', async () => {
    (repo.findPageVersions as jest.Mock).mockResolvedValue([
      { id: 'v-1', title: 'Draft v1', pageId: 'p-1' },
    ]);

    const result = await service.getVersions('p-1');
    expect(result.versions.length).toBe(1);
  });
});
