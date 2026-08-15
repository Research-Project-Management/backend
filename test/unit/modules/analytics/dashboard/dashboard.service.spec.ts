import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from '@/modules/analytics/dashboard/dashboard.service';
import { DashboardRepository } from '@/modules/analytics/dashboard/dashboard.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';

describe('DashboardService', () => {
  let service: DashboardService;
  let repo: DashboardRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        {
          provide: RedisCacheService,
          useValue: {
            wrap: jest.fn().mockImplementation((_key, fn) => fn()),
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            del: jest.fn().mockResolvedValue(undefined),
            delPattern: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: DashboardRepository,
          useValue: {
            searchProjects: jest.fn().mockResolvedValue([]),
            searchPages: jest.fn().mockResolvedValue([]),
            searchFiles: jest.fn().mockResolvedValue([]),
            searchStickies: jest.fn().mockResolvedValue([]),
            findRecentProjects: jest.fn().mockResolvedValue([]),
            findRecentPages: jest.fn().mockResolvedValue([]),
            findRecentFiles: jest.fn().mockResolvedValue([]),
            findRecentFilesCreated: jest.fn().mockResolvedValue([]),
            findRecentTasks: jest.fn().mockResolvedValue([]),
            findProjectWithMembers: jest.fn(),
            findProjectFiles: jest.fn().mockResolvedValue([]),
            findProjectTasks: jest.fn().mockResolvedValue([]),
            countWorkspaceStats: jest.fn().mockResolvedValue({
              papers: 15,
              files: 10,
              projects: 2,
              members: 3,
            }),
          },
        },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
    repo = module.get<DashboardRepository>(DashboardRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return workspace overview counts', async () => {
    const overview = await service.getWorkspaceOverview('ws-1');
    expect(overview.stats.papers).toBe(15);
    expect(overview.stats.files).toBe(10);
    expect(overview.stats.projects).toBe(2);
    expect(overview.stats.members).toBe(3);
  });

  it('should return your-work data for user in workspace', async () => {
    const yourWork = await service.getYourWork('ws-1', 'user-1');
    expect(yourWork.success).toBe(true);
    expect(yourWork.workspaceId).toBe('ws-1');
    expect(yourWork.userId).toBe('user-1');
    expect(Array.isArray(yourWork.recent)).toBe(true);
    expect(Array.isArray(yourWork.activity)).toBe(true);
  });
});
