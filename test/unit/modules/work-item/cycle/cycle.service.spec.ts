import { Test, TestingModule } from '@nestjs/testing';
import { CycleService } from '@/modules/work-item/cycle/cycle.service';
import { CycleRepository } from '@/modules/work-item/cycle/cycle.repository';
import { WorkItemService } from '@/modules/work-item/work-item.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('CycleService', () => {
  let service: CycleService;
  let repo: jest.Mocked<CycleRepository>;
  let eventEmitter: EventEmitter2;
  let cache: jest.Mocked<RedisCacheService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CycleService,
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
        {
          provide: RedisCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
            wrap: jest.fn((key, fn) => fn()),
          },
        },
        {
          provide: CycleRepository,
          useValue: {
            findProjectCycles: jest.fn(),
            findCycleById: jest.fn(),
            findCycleTasks: jest.fn().mockResolvedValue([]),
            createCycle: jest.fn(),
            updateCycle: jest.fn(),
            softDeleteCycle: jest.fn(),
            restoreCycle: jest.fn(),
            deleteCycle: jest.fn(),
          },
        },
        {
          provide: WorkItemService,
          useValue: {
            updateTask: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CycleService>(CycleService);
    repo = module.get(CycleRepository);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    cache = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create cycle successfully and emit cycle.created event', async () => {
    repo.createCycle.mockResolvedValue({
      id: 'cyc-1',
      name: 'Sprint 1',
      projectId: 'proj-1',
    } as any);

    const result = await service.createCycle('proj-1', 'user-1', {
      name: 'Sprint 1',
    });

    expect(result.cycle.name).toBe('Sprint 1');
    expect(result.cycle.id).toBe('cyc-1');
    expect(cache.del).toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'cycle.created',
      expect.objectContaining({
        entityId: 'cyc-1',
        projectId: 'proj-1',
      }),
    );
  });

  it('should get cycles and use cache', async () => {
    const mockCycles = [
      {
        id: 'cyc-1',
        name: 'Sprint 1',
        status: 'active',
        endDate: new Date('2020-01-01'),
      },
    ];
    repo.findProjectCycles.mockResolvedValue(mockCycles as any);

    const result = await service.getCycles('proj-1');

    expect(result.cycles).toHaveLength(1);
  });

  it('should soft delete cycle and invalidate cache', async () => {
    repo.findCycleById.mockResolvedValue({
      id: 'cyc-1',
      projectId: 'proj-1',
    } as any);
    repo.softDeleteCycle.mockResolvedValue({ id: 'cyc-1' } as any);

    const result = await service.deleteCycle('cyc-1');
    expect(result.message).toContain('soft-deleted');
    expect(repo.softDeleteCycle).toHaveBeenCalledWith('cyc-1');
    expect(cache.del).toHaveBeenCalled();
  });

  it('should restore soft-deleted cycle', async () => {
    repo.restoreCycle.mockResolvedValue({
      id: 'cyc-1',
      projectId: 'proj-1',
    } as any);

    const result = await service.restoreCycle('cyc-1');
    expect(result.message).toContain('restored');
    expect(repo.restoreCycle).toHaveBeenCalledWith('cyc-1');
  });
});
