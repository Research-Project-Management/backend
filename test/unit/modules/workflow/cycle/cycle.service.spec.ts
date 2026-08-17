import { Test, TestingModule } from '@nestjs/testing';
import { CycleService } from '@/modules/workflow/cycle/cycle.service';
import { CycleRepository } from '@/modules/workflow/cycle/cycle.repository';
import { TaskService } from '@/modules/workflow/task/task.service';

describe('CycleService', () => {
  let service: CycleService;
  let repo: CycleRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CycleService,
        {
          provide: CycleRepository,
          useValue: {
            findProjectCycles: jest.fn(),
            findCycleById: jest.fn(),
            createCycle: jest.fn(),
            updateCycle: jest.fn(),
            deleteCycle: jest.fn(),
          },
        },
        {
          provide: TaskService,
          useValue: {
            updateTask: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CycleService>(CycleService);
    repo = module.get<CycleRepository>(CycleRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create cycle successfully', async () => {
    (repo.createCycle as jest.Mock).mockResolvedValue({
      id: 'cyc-1',
      name: 'Sprint 1',
      projectId: 'proj-1',
    });

    const result = await service.createCycle('proj-1', 'user-1', {
      name: 'Sprint 1',
    });

    expect(result.cycle.name).toBe('Sprint 1');
    expect(result.cycle.id).toBe('cyc-1');
  });

  it('should get cycles as a pure read without triggering database update writes', async () => {
    const mockCycles = [
      {
        id: 'cyc-1',
        name: 'Sprint 1',
        status: 'active',
        endDate: new Date('2020-01-01'),
      },
    ];
    (repo.findProjectCycles as jest.Mock).mockResolvedValue(mockCycles);

    const result = await service.getCycles('proj-1');

    expect(result.cycles).toHaveLength(1);
    expect(repo.updateCycle).not.toHaveBeenCalled();
  });
});
