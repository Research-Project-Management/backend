import { Test, TestingModule } from '@nestjs/testing';
import { ActivityService } from '@/modules/activity/activity.service';
import { ActivityRepository } from '@/modules/activity/activity.repository';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core/cache/redis-cache.service';

describe('ActivityService', () => {
  let service: ActivityService;
  let repo: ActivityRepository;
  let cache: jest.Mocked<RedisCacheService>;

  const mockDate = new Date();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityService,
        {
          provide: RedisCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
            delPattern: jest.fn(),
          },
        },
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
            findEntitiesTitleMap: jest
              .fn()
              .mockResolvedValue(new Map([['task:task-1', 'Test Task']])),
            findFallbackRecentItems: jest.fn().mockResolvedValue({
              tasks: [],
              papers: [],
              pages: [],
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ActivityService>(ActivityService);
    repo = module.get<ActivityRepository>(ActivityRepository);
    cache = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should record an activity event and invalidate feed cache', async () => {
    const event = new DomainActivityEvent({
      entityType: 'task',
      entityId: 'task-100',
      verb: 'updated',
      field: 'state',
      oldValue: 'todo',
      newValue: 'doing',
      actorId: 'user-1',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
    });

    const result = await service.recordEvent(event);
    expect(result).toBeDefined();
    expect(repo.create).toHaveBeenCalledWith(event);
    expect(cache.del).toHaveBeenCalled();
  });

  it('should return paginated workspace activity feed and cache default page', async () => {
    const feed = await service.getActivityFeed('ws-1', { page: 1, limit: 50 });
    expect(feed.items.length).toBe(1);
    expect(feed.total).toBe(1);
    expect(feed.page).toBe(1);
    expect(cache.set).toHaveBeenCalled();
  });

  it('should return task specific activity timeline (Plane.so style)', async () => {
    const feed = await service.getTaskActivity('task-1', 50);
    expect(feed.activities.length).toBe(1);
    expect(feed.activities[0].verb).toBe('status_changed');
    expect(cache.set).toHaveBeenCalled();
  });

  it('should return recent items resolved with titles and cache result', async () => {
    const recents = await service.getRecentItems('ws-1', 'user-1', 10);
    expect(recents.length).toBe(1);
    expect(recents[0].title).toBe('Test Task');
    expect(recents[0].entityType).toBe('task');
    expect(cache.set).toHaveBeenCalled();
  });
});
