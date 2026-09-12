import { Test, TestingModule } from '@nestjs/testing';
import { ActivityService } from '@/modules/activity/activity.service';
import { ActivityRepository } from '@/modules/activity/activity.repository';
import { RedisCacheService } from '@/core/cache/redis.service';
import { EntityType } from '@prisma/client';

describe('ActivityService (Unit)', () => {
  let service: ActivityService;
  let repository: Partial<ActivityRepository>;
  let cache: Partial<RedisCacheService>;

  const mockProjectId = 'proj-1111-1111-1111-111111111111';
  const mockUserId = 'user-1111-1111-1111-111111111111';

  const mockActor = {
    id: mockUserId,
    name: 'Test Actor',
    email: 'actor@example.com',
    avatar: null,
  };

  const mockActivityEvent = {
    id: 'evt-1',
    entityType: EntityType.task,
    entityId: 'task-1',
    verb: 'created',
    field: null,
    oldValue: null,
    newValue: null,
    oldIdentifier: null,
    newIdentifier: 'PRJ-1',
    actorId: mockUserId,
    projectId: mockProjectId,
    createdAt: new Date(),
    actor: mockActor,
    project: { id: mockProjectId, name: 'Project 1' },
  } as any;

  beforeEach(async () => {
    repository = {
      create: jest.fn(),
      findProjectFeed: jest.fn(),
      findUserFeed: jest.fn(),
      findEntityFeed: jest.fn(),
      findRecentByActor: jest.fn(),
      findUserRecentEvents: jest.fn(),
      findEntitiesTitleMap: jest.fn(),
      findUserRecentItems: jest.fn(),
    };

    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityService,
        { provide: ActivityRepository, useValue: repository },
        { provide: RedisCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<ActivityService>(ActivityService);
  });

  describe('recordEvent', () => {
    it('should create event and invalidate cache', async () => {
      (repository.create as jest.Mock).mockResolvedValue(mockActivityEvent);

      const result = await service.recordEvent({
        entityType: EntityType.task,
        entityId: 'task-1',
        verb: 'created',
        projectId: mockProjectId,
        actorId: mockUserId,
      });

      expect(result).toBeDefined();
      expect(repository.create).toHaveBeenCalled();
      expect(cache.del).toHaveBeenCalled();
    });
  });

  describe('getProjectFeed', () => {
    it('should return project feed with pagination metadata', async () => {
      (repository.findProjectFeed as jest.Mock).mockResolvedValue({
        items: [mockActivityEvent],
        total: 1,
      });

      const result = await service.getProjectFeed(mockProjectId, { page: 1, limit: 10 });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
      expect(repository.findProjectFeed).toHaveBeenCalledWith(mockProjectId, {
        entityType: undefined,
        limit: 10,
        offset: 0,
      });
    });
  });

  describe('getUserFeed', () => {
    it('should return user feed with pagination metadata', async () => {
      (repository.findUserFeed as jest.Mock).mockResolvedValue({
        items: [mockActivityEvent],
        total: 1,
      });

      const result = await service.getUserFeed(mockUserId, { page: 1, limit: 10 });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
      expect(repository.findUserFeed).toHaveBeenCalledWith(mockUserId, {
        projectId: undefined,
        entityType: undefined,
        limit: 10,
        offset: 0,
      });
    });
  });

  describe('getActivityFeed', () => {
    it('should delegate to getProjectFeed if projectId option is present', async () => {
      (repository.findProjectFeed as jest.Mock).mockResolvedValue({
        items: [mockActivityEvent],
        total: 1,
      });

      const result = await service.getActivityFeed({
        projectId: mockProjectId,
        page: 1,
        limit: 20,
      });

      expect(result.items).toHaveLength(1);
      expect(repository.findProjectFeed).toHaveBeenCalled();
    });

    it('should delegate to getUserFeed if userId option is present', async () => {
      (repository.findUserFeed as jest.Mock).mockResolvedValue({
        items: [mockActivityEvent],
        total: 1,
      });

      const result = await service.getActivityFeed({
        userId: mockUserId,
        page: 1,
        limit: 20,
      });

      expect(result.items).toHaveLength(1);
      expect(repository.findUserFeed).toHaveBeenCalled();
    });
  });

  describe('getRecentItems', () => {
    it('should query recent events and resolve title map', async () => {
      (repository.findRecentByActor as jest.Mock).mockResolvedValue([mockActivityEvent]);
      const titleMap = new Map<string, string>();
      titleMap.set('task:task-1', 'WorkItem One');
      (repository.findEntitiesTitleMap as jest.Mock).mockResolvedValue(titleMap);

      const items = await service.getRecentItems(undefined, mockUserId, 10);

      expect(items).toHaveLength(1);
      expect(items[0].entityType).toBe('task');
      expect(items[0].title).toBe('WorkItem One');
    });

    it('should fallback to findUserRecentItems when no recent events are found', async () => {
      (repository.findRecentByActor as jest.Mock).mockResolvedValue([]);
      (repository.findUserRecentItems as jest.Mock).mockResolvedValue({
        tasks: [{ id: 'task-1', title: 'WorkItem One', projectId: mockProjectId, updatedAt: new Date() }],
        papers: [],
        pages: [],
      });

      const items = await service.getRecentItems(undefined, mockUserId, 10);

      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('WorkItem One');
      expect(repository.findUserRecentItems).toHaveBeenCalledWith(mockUserId, 10);
    });
  });
});

