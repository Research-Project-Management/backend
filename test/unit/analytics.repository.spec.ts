import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsRepository } from '@/modules/analytics/analytics.repository';
import { PrismaService } from '@/core/database/prisma.service';

describe('AnalyticsRepository (Unit)', () => {
  let repository: AnalyticsRepository;
  let prisma: any;

  const mockProjectId = '11111111-1111-4111-8111-111111111111';
  const mockUserId = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    prisma = {
      project: { findFirst: jest.fn() },
      projectMember: { count: jest.fn().mockResolvedValue(5) },
      workItem: {
        count: jest.fn().mockResolvedValue(20),
        findMany: jest.fn().mockResolvedValue([]),
      },
      page: { count: jest.fn().mockResolvedValue(8) },
      file: { count: jest.fn().mockResolvedValue(12) },
      sticky: { count: jest.fn().mockResolvedValue(4) },
      cycle: { count: jest.fn().mockResolvedValue(3) },
      item: { count: jest.fn().mockResolvedValue(15) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get<AnalyticsRepository>(AnalyticsRepository);
  });

  describe('countProjectStats', () => {
    it('accurately aggregates all 7 entity dimensions without mock placeholders', async () => {
      const result = await repository.countProjectStats(mockProjectId);

      expect(result).toEqual({
        members: 5,
        tasks: 20,
        pages: 8,
        files: 12,
        stickies: 4,
        cycles: 3,
        papers: 15,
      });

      expect(prisma.sticky.count).toHaveBeenCalledWith({
        where: { projectId: mockProjectId, deletedAt: null },
      });
      expect(prisma.item.count).toHaveBeenCalledWith({
        where: { projectId: mockProjectId, deletedAt: null },
      });
      expect(prisma.file.count).toHaveBeenCalledWith({
        where: {
          linkedToType: 'project',
          linkedToId: mockProjectId,
          trashedAt: null,
        },
      });
    });

    it('returns zeroed stats when invalid identifier is provided and project does not exist', async () => {
      prisma.project.findFirst.mockResolvedValue(null);

      const result = await repository.countProjectStats('invalid-slug');

      expect(result).toEqual({
        members: 0,
        tasks: 0,
        pages: 0,
        files: 0,
        stickies: 0,
        cycles: 0,
        papers: 0,
      });
    });
  });

  describe('countUserStats', () => {
    it('aggregates user stats across personal and project scopes', async () => {
      const result = await repository.countUserStats(mockUserId);

      expect(result).toEqual({
        projects: 5,
        assignedWorkItems: 20,
        createdTasks: 20,
        pages: 8,
        stickies: 4,
        papers: 15,
      });

      expect(prisma.sticky.count).toHaveBeenCalledWith({
        where: { userId: mockUserId, deletedAt: null },
      });
      expect(prisma.item.count).toHaveBeenCalledWith({
        where: { userId: mockUserId, deletedAt: null },
      });
    });

    it('returns zeroed stats for invalid non-UUID user id', async () => {
      const result = await repository.countUserStats('non-uuid');

      expect(result).toEqual({
        projects: 0,
        assignedWorkItems: 0,
        createdTasks: 0,
        pages: 0,
        stickies: 0,
        papers: 0,
      });
    });
  });
});
