import { Test, TestingModule } from '@nestjs/testing';
import { WorklogService } from '@/modules/workflow/worklog/worklog.service';
import { WorklogRepository } from '@/modules/workflow/worklog/worklog.repository';
import { NotFoundException } from '@nestjs/common';

describe('WorklogService', () => {
  let service: WorklogService;
  let repo: WorklogRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorklogService,
        {
          provide: WorklogRepository,
          useValue: {
            findProjectWorklogs: jest.fn(),
            findWorkspaceWorklogs: jest.fn(),
            createWorklog: jest.fn(),
            deleteWorklog: jest.fn(),
            resolveWorkspaceId: jest.fn().mockResolvedValue('ws-1'),
          },
        },
      ],
    }).compile();

    service = module.get<WorklogService>(WorklogService);
    repo = module.get<WorklogRepository>(WorklogRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should get project worklogs with pagination and totalHours calculation', async () => {
    (repo.findProjectWorklogs as jest.Mock).mockResolvedValue({
      items: [
        { id: 'wl-1', hours: 3.5, description: 'Experiment 1', date: new Date() },
        { id: 'wl-2', hours: 2.0, description: 'Analysis 2', date: new Date() },
      ],
      total: 2,
    });

    const result = await service.getProjectWorklogs('proj-1', { page: 1, limit: 10 });

    expect(result.items.length).toBe(2);
    expect(result.total).toBe(2);
    expect(result.totalHours).toBe(5.5);
  });

  it('should create worklog successfully', async () => {
    (repo.createWorklog as jest.Mock).mockResolvedValue({
      id: 'wl-1',
      hours: 4.0,
      description: 'Writing manuscript draft',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const result = await service.createWorklog('proj-1', 'user-1', {
      hours: 4.0,
      description: 'Writing manuscript draft',
    });

    expect(result.success).toBe(true);
    expect(result.data.hours).toBe(4.0);
  });

  it('should throw NotFoundException if project workspace cannot be resolved', async () => {
    (repo.resolveWorkspaceId as jest.Mock).mockResolvedValue(null);

    await expect(
      service.createWorklog('invalid-proj', 'user-1', { hours: 2 }),
    ).rejects.toThrow(NotFoundException);
  });
});
