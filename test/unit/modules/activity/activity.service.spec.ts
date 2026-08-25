import { Test, TestingModule } from '@nestjs/testing';
import { ActivityService } from '@/modules/activity/activity.service';
import { ActivityRepository } from '@/modules/activity/activity.repository';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';

describe('ActivityService', () => {
  let service: ActivityService;
  let repo: ActivityRepository;

  const mockDate = new Date();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityService,
        {
          provide: ActivityRepository,
          useValue: {
            resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
            create: jest.fn().mockImplementation((dto) =>
              Promise.resolve({
                id: 'evt-1',
                ...dto,
                createdAt: mockDate,
              }),
            ),
            findWorkspaceFeed: jest.fn().mockResolvedValue({
              items: [
                {
                  id: 'evt-1',
                  entityType: 'task',
                  entityId: 'task-1',
                  verb: 'created',
                  actorId: 'user-1',
                  workspaceId: 'ws-1',
                  createdAt: mockDate,
                  actor: {
                    id: 'user-1',
                    name: 'Alice',
                    email: 'alice@test.com',
                    avatar: null,
                  },
                },
              ],
              total: 1,
            }),
            findEntityFeed: jest.fn().mockResolvedValue([
              {
                id: 'evt-1',
                entityType: 'task',
                entityId: 'task-1',
                verb: 'status_changed',
                actorId: 'user-1',
                workspaceId: 'ws-1',
                createdAt: mockDate,
                actor: {
                  id: 'user-1',
                  name: 'Alice',
                  email: 'alice@test.com',
                  avatar: null,
                },
              },
            ]),
            findRecentByActor: jest.fn().mockResolvedValue([
              {
                id: 'evt-1',
                entityType: 'task',
                entityId: 'task-1',
                actorId: 'user-1',
                workspaceId: 'ws-1',
                createdAt: mockDate,
              },
            ]),
            findEntitiesTitleMap: jest.fn().mockResolvedValue(
              new Map([['task:task-1', 'Test Task']]),
            ),
            findFallbackRecentItems: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<ActivityService>(ActivityService);
    repo = module.get<ActivityRepository>(ActivityRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should record an activity event', async () => {
    const event = new DomainActivityEvent({
      entityType: 'task',
      entityId: 'task-100',
      verb: 'updated',
      field: 'state',
      oldValue: 'todo',
      newValue: 'doing',
      actorId: 'user-1',
      workspaceId: 'ws-1',
    });

    const result = await service.recordEvent(event);
    expect(result).toBeDefined();
    expect(repo.create).toHaveBeenCalledWith(event);
  });

  it('should return paginated workspace activity feed', async () => {
    const feed = await service.getActivityFeed('ws-1', { page: 1, limit: 10 });
    expect(feed.items.length).toBe(1);
    expect(feed.total).toBe(1);
    expect(feed.page).toBe(1);
  });

  it('should return task specific activity timeline (Plane.so style)', async () => {
    const feed = await service.getTaskActivity('task-1', 10);
    expect(feed.activities.length).toBe(1);
    expect(feed.activities[0].verb).toBe('status_changed');
  });

  it('should return recent items resolved with titles', async () => {
    const recents = await service.getRecentItems('ws-1', 'user-1', 5);
    expect(recents.length).toBe(1);
    expect(recents[0].title).toBe('Test Task');
    expect(recents[0].entityType).toBe('task');
  });
});
