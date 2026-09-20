import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { OverviewService } from '@/modules/project/overview/overview.service';
import { OverviewRepository } from '@/modules/project/overview/overview.repository';
import { ProjectPriority } from '@prisma/client';

describe('Project Overview Module', () => {
  describe('OverviewService', () => {
    let service: OverviewService;
    let repo: jest.Mocked<OverviewRepository>;

    beforeEach(async () => {
      const mockRepo = {
        getProjectMetadata: jest.fn(),
        getWorkItemStateGroupCounts: jest.fn(),
        getActiveCycle: jest.fn(),
        getOverdueCount: jest.fn(),
        getRecentActivities: jest.fn(),
        getLatestStatusUpdate: jest.fn(),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OverviewService,
          { provide: OverviewRepository, useValue: mockRepo },
        ],
      }).compile();

      service = module.get<OverviewService>(OverviewService);
      repo = module.get(OverviewRepository);
    });

    it('should aggregate project overview and compute metrics correctly', async () => {
      const mockProject = {
        id: 'proj-1',
        name: 'Research Paper',
        identifier: 'RES',
        description: 'Study on ML',
        avatar: null,
        coverImage: null,
        stateId: 'state-1',
        state: {
          id: 'state-1',
          projectId: 'proj-1',
          name: 'Triển khai & Thực nghiệm',
          description: null,
          color: '#d97706',
          sequence: 3,
          isDefault: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        priority: ProjectPriority.high,
        startDate: new Date('2026-01-01'),
        targetDate: new Date('2026-12-31'),
        createdBy: {
          id: 'u-1',
          name: 'Dr. John',
          profile: { name: 'Dr. John', avatar: null },
          avatar: null,
        },
        members: [
          {
            user: {
              id: 'u-1',
              name: 'Dr. John',
              profile: { name: 'Dr. John', avatar: null },
              avatar: null,
            },
          },
        ],
        _count: { members: 5 },
      };

      repo.getProjectMetadata.mockResolvedValue(mockProject as any);
      repo.getWorkItemStateGroupCounts.mockResolvedValue({
        backlog: 5,
        unstarted: 5,
        started: 10,
        completed: 20,
        cancelled: 2,
      });
      repo.getActiveCycle.mockResolvedValue({
        activeCycle: {
          id: 'cycle-1',
          name: 'Sprint 1',
          startDate: new Date('2026-02-01'),
          endDate: new Date('2026-02-14'),
          _count: { workItems: 10 },
        },
        completedIssues: 6,
      } as any);
      repo.getOverdueCount.mockResolvedValue(3);
      repo.getLatestStatusUpdate.mockResolvedValue({
        id: 'update-1',
        status: 'on_track',
        message: 'Everything on track',
        createdAt: new Date(),
        createdBy: {
          id: 'u-1',
          profile: { name: 'Dr. John', avatar: null },
        },
      });
      repo.getRecentActivities.mockResolvedValue([
        {
          id: 'act-1',
          verb: 'updated',
          field: 'state',
          oldValue: 'Started',
          newValue: 'Completed',
          oldIdentifier: null,
          newIdentifier: null,
          createdAt: new Date(),
          actor: { id: 'u-2', profile: { name: 'Bob', avatar: null } },
        },
      ]);

      const result = await service.getProjectOverview('proj-1');

      // Check project metadata
      expect(result.project.id).toBe('proj-1');
      expect(result.project.name).toBe('Research Paper');
      expect(result.project.identifier).toBe('RES');
      expect(result.project.totalMembers).toBe(5);
      expect(result.project.lead?.name).toBe('Dr. John');

      // Check metrics (backlog + unstarted + started + completed + cancelled = 5 + 5 + 10 + 20 + 2 = 42)
      expect(result.metrics.totalIssues).toBe(42);
      expect(result.metrics.completed).toBe(20);
      expect(result.metrics.started).toBe(10);
      expect(result.metrics.unstarted).toBe(5);
      expect(result.metrics.backlog).toBe(5);
      expect(result.metrics.overdue).toBe(3);
      expect(result.metrics.completionPercentage).toBe(50.0);

      // Check active cycle
      expect(result.activeCycle?.name).toBe('Sprint 1');
      expect(result.activeCycle?.totalIssues).toBe(10);
      expect(result.activeCycle?.completedIssues).toBe(6);
      expect(result.activeCycle?.completionPercentage).toBe(60.0);

      // Check activities
      expect(result.recentActivities).toHaveLength(1);
      expect(result.recentActivities[0].actor.name).toBe('Bob');
    });

    it('should throw NotFoundException if project does not exist', async () => {
      repo.getProjectMetadata.mockResolvedValue(null);

      await expect(service.getProjectOverview('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
