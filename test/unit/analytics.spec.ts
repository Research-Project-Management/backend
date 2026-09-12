import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from '@/modules/analytics/analytics.service';
import { AnalyticsRepository } from '@/modules/analytics/analytics.repository';
import { RedisCacheService } from '@/core/cache/redis.service';

describe('AnalyticsService (Unit)', () => {
  let service: AnalyticsService;
  let repository: Partial<AnalyticsRepository>;
  let cache: Partial<RedisCacheService>;

  const mockProjectId = 'proj-1111-1111-1111-111111111111';
  const mockCycleId = 'cycle-1111-1111-1111-111111111111';
  const mockUserId = 'user-1111-1111-1111-111111111111';

  beforeEach(async () => {
    repository = {
      countProjectStats: jest.fn(),
      countUserStats: jest.fn(),
      findProjectTasksWithAssignees: jest.fn(),
      findCycleTasks: jest.fn(),
      findProjectTasksByLabel: jest.fn(),
      findProjectTasksTimeSeries: jest.fn(),
      findCycleTasksWithDates: jest.fn(),
      findCycleById: jest.fn(),
    };

    cache = {
      wrap: jest.fn().mockImplementation((key, fn) => fn()),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: AnalyticsRepository, useValue: repository },
        { provide: RedisCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  describe('getProjectOverview', () => {
    it('should return project dimensional stats', async () => {
      const mockStats = {
        members: 5,
        tasks: 25,
        pages: 8,
        files: 12,
        stickies: 4,
        cycles: 3,
        papers: 7,
      };
      (repository.countProjectStats as jest.Mock).mockResolvedValue(mockStats);

      const result = await service.getProjectOverview(mockProjectId);

      expect(result.stats).toEqual(mockStats);
      expect(repository.countProjectStats).toHaveBeenCalledWith(mockProjectId);
    });
  });

  describe('getUserOverview', () => {
    it('should return user personal stats', async () => {
      const mockUserStats = {
        projects: 3,
        assignedTasks: 10,
        createdTasks: 5,
        pages: 4,
        stickies: 2,
        papers: 3,
      };
      (repository.countUserStats as jest.Mock).mockResolvedValue(mockUserStats);

      const result = await service.getUserOverview(mockUserId);

      expect(result.stats).toEqual(mockUserStats);
      expect(repository.countUserStats).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe('getProjectAnalytics', () => {
    it('should aggregate tasks by state, priority, and assignee', async () => {
      const mockTasks = [
        {
          id: 'task-1',
          columnId: 'todo',
          priority: 'urgent',
          completed: false,
          assigneeId: mockUserId,
          assignee: { id: mockUserId, name: 'User 1', email: 'u1@test.com', avatar: null },
        },
        {
          id: 'task-2',
          columnId: 'done',
          priority: 'high',
          completed: true,
          assigneeId: mockUserId,
          assignee: { id: mockUserId, name: 'User 1', email: 'u1@test.com', avatar: null },
        },
      ];
      (repository.findProjectTasksWithAssignees as jest.Mock).mockResolvedValue(mockTasks);

      const result = await service.getProjectAnalytics(mockProjectId);

      expect(result.state).toBeDefined();
      expect(result.priority).toBeDefined();
      expect(result.assignee).toBeDefined();
      expect(result.assignee.length).toBeGreaterThan(0);
    });
  });

  describe('getCycleAnalytics', () => {
    it('should calculate cycle completion metrics', async () => {
      const mockCycleTasks = [
        { id: 'task-1', columnId: 'done', completed: true, priority: 'urgent' },
        { id: 'task-2', columnId: 'in_progress', completed: false, priority: 'medium' },
        { id: 'task-3', columnId: 'todo', completed: false, priority: 'low' },
      ];
      (repository.findCycleTasks as jest.Mock).mockResolvedValue(mockCycleTasks);

      const result = await service.getCycleAnalytics(mockCycleId);

      expect(result.cycleId).toBe(mockCycleId);
      expect(result.totalTasks).toBe(3);
      expect(result.completedTasks).toBe(1);
      expect(result.completionRate).toBe(33);
    });
  });

  describe('getLabelDistribution', () => {
    it('should return labels with WorkItem counts sorted descending', async () => {
      (repository.findProjectTasksByLabel as jest.Mock).mockResolvedValue([
        { id: 't-1', labels: ['bug', 'frontend'] },
        { id: 't-2', labels: ['bug'] },
      ]);

      const result = await service.getLabelDistribution(mockProjectId);

      expect(result.labels).toHaveLength(2);
      expect(result.labels[0]).toEqual({ label: 'bug', count: 2 });
      expect(result.labels[1]).toEqual({ label: 'frontend', count: 1 });
    });
  });

  describe('getCycleVelocity', () => {
    it('should compute velocity rate for cycle', async () => {
      (repository.findCycleTasks as jest.Mock).mockResolvedValue([
        { id: 't-1', completed: true },
        { id: 't-2', completed: false },
      ]);

      const result = await service.getCycleVelocity(mockCycleId);

      expect(result.totalTasks).toBe(2);
      expect(result.completedTasks).toBe(1);
      expect(result.pendingTasks).toBe(1);
      expect(result.velocityRate).toBe(50);
    });
  });
});
