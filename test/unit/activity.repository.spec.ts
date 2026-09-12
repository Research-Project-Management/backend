import { Test, TestingModule } from '@nestjs/testing';
import { ActivityRepository } from '@/modules/activity/activity.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { EntityType } from '@prisma/client';

describe('ActivityRepository (Unit) - Zero-Workspace Two-Tier Isolation', () => {
  let repository: ActivityRepository;
  let prisma: any;

  const mockProjectId = '11111111-1111-4111-8111-111111111111';
  const mockUserId = '22222222-2222-4222-8222-222222222222';
  const mockEventId = '33333333-3333-4333-8333-333333333333';

  beforeEach(async () => {
    prisma = {
      activityEvent: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get<ActivityRepository>(ActivityRepository);
  });

  describe('create', () => {
    it('creates ActivityEvent without any workspaceId property', async () => {
      const mockEvent = {
        id: mockEventId,
        entityType: EntityType.task,
        entityId: 'task-123',
        verb: 'created',
        field: null,
        oldValue: null,
        newValue: null,
        oldIdentifier: null,
        newIdentifier: 'PRJ-123',
        actorId: mockUserId,
        projectId: mockProjectId,
        createdAt: new Date(),
      };
      prisma.activityEvent.create.mockResolvedValue(mockEvent);

      const result = await repository.create({
        entityType: EntityType.task,
        entityId: 'task-123',
        verb: 'created',
        actorId: mockUserId,
        projectId: mockProjectId,
      });

      expect(prisma.activityEvent.create).toHaveBeenCalledWith({
        data: {
          entityType: EntityType.task,
          entityId: 'task-123',
          verb: 'created',
          field: undefined,
          oldValue: undefined,
          newValue: undefined,
          oldIdentifier: undefined,
          newIdentifier: undefined,
          actorId: mockUserId,
          projectId: mockProjectId,
        },
      });
      expect(result).toEqual(mockEvent);
    });
  });

  describe('findProjectFeed', () => {
    it('queries events strictly scoped to projectId', async () => {
      prisma.activityEvent.findMany.mockResolvedValue([]);
      prisma.activityEvent.count.mockResolvedValue(0);

      await repository.findProjectFeed(mockProjectId, { limit: 20, offset: 0 });

      expect(prisma.activityEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectId: mockProjectId },
          take: 20,
          skip: 0,
        }),
      );
      expect(prisma.activityEvent.count).toHaveBeenCalledWith({
        where: { projectId: mockProjectId },
      });
    });
  });

  describe('findUserFeed', () => {
    it('queries events for user personal actions or projects where user is a member', async () => {
      prisma.activityEvent.findMany.mockResolvedValue([]);
      prisma.activityEvent.count.mockResolvedValue(0);

      await repository.findUserFeed(mockUserId, { limit: 10, offset: 0 });

      expect(prisma.activityEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { actorId: mockUserId },
              { project: { members: { some: { userId: mockUserId } } } },
            ],
          },
          take: 10,
          skip: 0,
        }),
      );
    });
  });
});
