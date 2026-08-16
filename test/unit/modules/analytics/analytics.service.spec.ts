import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from '@/modules/analytics/analytics.service';
import { AnalyticsRepository } from '@/modules/analytics/analytics.repository';
import { ActivityService } from '@/modules/activity/activity.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let repo: AnalyticsRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
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
          provide: ActivityService,
          useValue: {
            getActivityFeed: jest.fn().mockResolvedValue({ items: [], total: 0 }),
            getRecentItems: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: AnalyticsRepository,
          useValue: {
            countWorkspaceStats: jest.fn().mockResolvedValue({
              members: 2,
              projects: 1,
              tasks: 10,
              papers: 5,
              pages: 3,
              files: 4,
              stickies: 2,
            }),
            findProjectTasksWithAssignees: jest.fn().mockResolvedValue([
              {
                id: 't-1',
                columnId: 'done',
                priority: 'urgent',
                completed: true,
                assigneeId: 'u-1',
                assignee: { id: 'u-1', name: 'Alice', email: 'alice@test.com', avatar: null },
              },
              {
                id: 't-2',
                columnId: 'doing',
                priority: 'high',
                completed: false,
                assigneeId: 'u-1',
                assignee: { id: 'u-1', name: 'Alice', email: 'alice@test.com', avatar: null },
              },
            ]),
            findCycleTasks: jest.fn().mockResolvedValue([
              { id: 't-1', columnId: 'done', completed: true, priority: 'urgent' },
              { id: 't-2', columnId: 'doing', completed: false, priority: 'high' },
            ]),
            findUserWorkspaceTasks: jest.fn().mockResolvedValue([
              {
                id: 'task-1',
                title: 'Assigned Task',
                assigneeId: 'user-1',
                authorId: 'user-2',
                comments: [],
              },
              {
                id: 'task-2',
                title: 'Created Task',
                assigneeId: 'user-2',
                authorId: 'user-1',
                comments: [],
              },
            ]),
          },
        },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    repo = module.get<AnalyticsRepository>(AnalyticsRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should aggregate workspace stats', async () => {
    const result = await service.getWorkspaceOverview('ws-1');

    expect(result.stats.members).toBe(2);
    expect(result.stats.projects).toBe(1);
    expect(result.stats.tasks).toBe(10);
    expect(result.stats.papers).toBe(5);
  });

  it('should return project dimensional analytics (Plane.so style)', async () => {
    const result = await service.getProjectAnalytics('proj-1');

    expect(result.state['done']).toBe(1);
    expect(result.state['doing']).toBe(1);
    expect(result.priority['urgent']).toBe(1);
    expect(result.assignee.length).toBe(1);
    expect(result.assignee[0].name).toBe('Alice');
    expect(result.assignee[0].count).toBe(2);
  });

  it('should return cycle burndown analytics', async () => {
    const result = await service.getCycleAnalytics('cycle-1');

    expect(result.totalTasks).toBe(2);
    expect(result.completedTasks).toBe(1);
    expect(result.inProgressTasks).toBe(1);
    expect(result.completionRate).toBe(50);
  });

  it('should categorize user tasks in your-work', async () => {
    const result = await service.getYourWork('ws-1', 'user-1');

    expect(result.success).toBe(true);
    expect(result.assigned.length).toBe(1);
    expect(result.assigned[0].id).toBe('task-1');
    expect(result.created.length).toBe(1);
    expect(result.created[0].id).toBe('task-2');
  });
});
