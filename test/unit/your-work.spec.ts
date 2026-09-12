import { Test, TestingModule } from '@nestjs/testing';
import { YourWorkService } from '@/modules/analytics/your-work/your-work.service';
import { YourWorkRepository } from '@/modules/analytics/your-work/your-work.repository';
import { ActivityService } from '@/modules/activity/activity.service';

describe('YourWorkService (Unit)', () => {
  let service: YourWorkService;

  const mockTasks = [
    {
      id: 'task-1',
      title: 'Task 1',
      identifier: 'PRJ-1',
      priority: 'high',
      assigneeId: 'user-1',
      authorId: 'user-2',
      columnId: 'todo',
      projectId: 'prj-1',
      comments: [],
      project: {
        id: 'prj-1',
        name: 'Project Alpha',
        identifier: 'PRJ',
        avatar: null,
        taskColumns: [{ id: 'todo', name: 'To Do' }],
      },
    },
    {
      id: 'task-2',
      title: 'Task 2',
      identifier: 'PRJ-2',
      priority: 'urgent',
      assigneeId: 'user-2',
      authorId: 'user-1',
      columnId: 'done',
      projectId: 'prj-1',
      comments: [],
      project: {
        id: 'prj-1',
        name: 'Project Alpha',
        identifier: 'PRJ',
        avatar: null,
        taskColumns: [{ id: 'done', name: 'Done' }],
      },
    },
  ] as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        YourWorkService,
        {
          provide: YourWorkRepository,
          useValue: {
            findUserWorkspaceTasks: jest.fn().mockResolvedValue(mockTasks),
            findUserProfile: jest.fn().mockResolvedValue({
              id: 'user-1',
              name: 'Test User',
              email: 'test@example.com',
              avatar: null,
              createdAt: new Date('2026-03-04T00:00:00Z'),
            }),
            findUserWorkspaceProjects: jest.fn().mockResolvedValue([
              {
                id: 'prj-1',
                name: 'Project Alpha',
                identifier: 'PRJ',
                avatar: null,
                taskColumns: [
                  { id: 'todo', name: 'To Do' },
                  { id: 'done', name: 'Done' },
                ],
              },
            ]),
          },
        },
        {
          provide: ActivityService,
          useValue: {
            getActivityFeed: jest.fn().mockResolvedValue({ items: [] }),
            getRecentItems: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<YourWorkService>(YourWorkService);
  });

  it('should aggregate tasks and return profile metadata', async () => {
    const result = await service.getYourWork('ws-1', 'user-1');

    expect(result.success).toBe(true);
    expect(result.assigned.length).toBe(1);
    expect(result.assigned[0].id).toBe('task-1');
    expect(result.created.length).toBe(1);
    expect(result.created[0].id).toBe('task-2');
    expect(result.userData).toBeDefined();
    expect(result.userData?.name).toBe('Test User');
    expect(result.userData?.email).toBe('test@example.com');
    expect(result.userData?.createdAt).toBe('2026-03-04T00:00:00.000Z');
    expect(result.projectBreakdown?.length).toBe(1);
    expect(result.projectBreakdown?.[0].projectName).toBe('Project Alpha');
  });
});
