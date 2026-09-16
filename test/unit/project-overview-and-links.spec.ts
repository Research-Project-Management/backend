import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { LinkService } from '@/modules/project/link/link.service';
import { LinkRepository } from '@/modules/project/link/link.repository';
import { OverviewService } from '@/modules/project/overview/overview.service';
import { OverviewRepository } from '@/modules/project/overview/overview.repository';
import { ProjectState, ProjectPriority } from '@prisma/client';

describe('Project Overview & Link Modules', () => {
  describe('LinkService', () => {
    let service: LinkService;
    let repo: jest.Mocked<LinkRepository>;

    beforeEach(async () => {
      const mockRepo = {
        findMany: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          LinkService,
          { provide: LinkRepository, useValue: mockRepo },
        ],
      }).compile();

      service = module.get<LinkService>(LinkService);
      repo = module.get(LinkRepository);
    });

    it('should list pinned links for a project', async () => {
      const mockLinks = [
        {
          id: 'link-1',
          projectId: 'proj-1',
          title: 'GitHub',
          url: 'https://github.com/flux',
          createdById: 'user-1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      repo.findMany.mockResolvedValue(mockLinks as any);

      const result = await service.getLinks('proj-1');
      expect(result).toEqual(mockLinks);
      expect(repo.findMany).toHaveBeenCalledWith('proj-1');
    });

    it('should create a new pinned link', async () => {
      const dto = { title: 'Docs', url: 'https://docs.flux.app' };
      const created = {
        id: 'link-2',
        projectId: 'proj-1',
        title: dto.title,
        url: dto.url,
        createdById: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      repo.create.mockResolvedValue(created as any);

      const result = await service.createLink('proj-1', 'user-1', dto);
      expect(result).toEqual(created);
      expect(repo.create).toHaveBeenCalledWith('proj-1', 'user-1', dto);
    });

    it('should update an existing link if it belongs to the project', async () => {
      repo.findById.mockResolvedValue({
        id: 'link-1',
        projectId: 'proj-1',
      } as any);
      repo.update.mockResolvedValue({
        id: 'link-1',
        title: 'New Docs',
      } as any);

      const result = await service.updateLink('proj-1', 'link-1', {
        title: 'New Docs',
      });
      expect(result.title).toBe('New Docs');
    });

    it('should throw NotFoundException if link does not belong to project on update', async () => {
      repo.findById.mockResolvedValue({
        id: 'link-1',
        projectId: 'different-proj',
      } as any);

      await expect(
        service.updateLink('proj-1', 'link-1', { title: 'New' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should delete link successfully', async () => {
      repo.findById.mockResolvedValue({
        id: 'link-1',
        projectId: 'proj-1',
      } as any);
      repo.delete.mockResolvedValue({ id: 'link-1' } as any);

      const result = await service.deleteLink('proj-1', 'link-1');
      expect(result.id).toBe('link-1');
    });
  });

  describe('OverviewService', () => {
    let service: OverviewService;
    let repo: jest.Mocked<OverviewRepository>;

    beforeEach(async () => {
      const mockRepo = {
        getProjectMetadata: jest.fn(),
        getWorkItemStateGroupCounts: jest.fn(),
        getOverdueCount: jest.fn(),
        getActiveCycle: jest.fn(),
        getRecentActivities: jest.fn(),
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
        state: ProjectState.execution,
        priority: ProjectPriority.high,
        startDate: new Date('2026-01-01'),
        targetDate: new Date('2026-12-31'),
        createdBy: { id: 'u-1', name: 'Dr. John', avatar: null },
        members: [{ user: { id: 'u-1', name: 'Dr. John', avatar: null } }],
        links: [
          {
            id: 'l-1',
            projectId: 'proj-1',
            title: 'Overleaf',
            url: 'https://overleaf.com/123',
            createdById: 'u-1',
            createdAt: new Date(),
            updatedAt: new Date(),
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
      repo.getOverdueCount.mockResolvedValue(3);
      repo.getActiveCycle.mockResolvedValue({
        activeCycle: {
          id: 'cyc-1',
          name: 'Sprint 1',
          startDate: new Date('2026-03-01'),
          endDate: new Date('2026-03-20'),
          _count: { workItems: 10 },
        },
        completedIssues: 6,
      });
      repo.getRecentActivities.mockResolvedValue([
        {
          id: 'act-1',
          verb: 'updated_state',
          field: 'state',
          oldValue: 'Started',
          newValue: 'Completed',
          oldIdentifier: null,
          newIdentifier: null,
          createdAt: new Date(),
          actor: { id: 'u-2', name: 'Bob', avatar: null },
        },
      ]);

      const result = await service.getProjectOverview('proj-1');

      // Check project metadata
      expect(result.project.id).toBe('proj-1');
      expect(result.project.name).toBe('Research Paper');
      expect(result.project.identifier).toBe('RES');
      expect(result.project.totalMembers).toBe(5);
      expect(result.project.lead?.name).toBe('Dr. John');

      // Check links
      expect(result.links).toHaveLength(1);
      expect(result.links[0].title).toBe('Overleaf');

      // Check metrics (backlog + unstarted + started + completed = 5 + 5 + 10 + 20 = 40)
      expect(result.metrics.totalIssues).toBe(40);
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
