import { StateService } from '@/modules/project/state/state.service';
import { StateRepository } from '@/modules/project/state/state.repository';
import { LabelService } from '@/modules/project/label/label.service';
import { LabelRepository } from '@/modules/project/label/label.repository';
import { FavoriteService } from '@/modules/project/favorite/favorite.service';
import { FavoriteRepository } from '@/modules/project/favorite/favorite.repository';
import { ArchiveService } from '@/modules/project/archive/archive.service';
import { ArchiveRepository } from '@/modules/project/archive/archive.repository';
import { ProjectAnalyticsService } from '@/modules/project/analytics/analytics.service';
import { ProjectAnalyticsRepository } from '@/modules/project/analytics/analytics.repository';
import { TemplateService } from '@/modules/project/template/template.service';
import { TemplateRepository } from '@/modules/project/template/template.repository';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProjectState, ProjectPriority } from '@prisma/client';

describe('Project Sub-Modules Specification (Single Responsibility)', () => {
  // ─── 1. State Module ───────────────────────────────────────────────────────
  describe('StateService', () => {
    let stateService: StateService;
    let mockStateRepo: any;

    beforeEach(() => {
      mockStateRepo = {
        findProjectState: jest.fn(),
        updateProjectState: jest.fn(),
      };
      stateService = new StateService(mockStateRepo as StateRepository);
    });

    it('should return catalog of all 6 project states with descriptions', () => {
      const catalog = stateService.getProjectStatesCatalog();
      expect(catalog).toHaveLength(6);
      expect(catalog.map((c) => c.state)).toEqual([
        'draft',
        'planning',
        'execution',
        'monitoring',
        'completed',
        'cancelled',
      ]);
    });

    it('should allow valid lifecycle transition from planning to execution', async () => {
      mockStateRepo.findProjectState.mockResolvedValue({
        id: 'proj-1',
        state: ProjectState.planning,
        name: 'Genome AI',
      });
      mockStateRepo.updateProjectState.mockResolvedValue({
        id: 'proj-1',
        state: ProjectState.execution,
      });

      const result = await stateService.updateProjectState(
        'proj-1',
        ProjectState.execution,
      );
      expect(result.state).toBe(ProjectState.execution);
      expect(mockStateRepo.updateProjectState).toHaveBeenCalledWith(
        'proj-1',
        ProjectState.execution,
      );
    });

    it('should reject invalid transition (e.g. completed to draft directly)', async () => {
      mockStateRepo.findProjectState.mockResolvedValue({
        id: 'proj-1',
        state: ProjectState.completed,
        name: 'Genome AI',
      });

      await expect(
        stateService.updateProjectState('proj-1', ProjectState.draft),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── 2. Label Module ───────────────────────────────────────────────────────
  describe('LabelService', () => {
    let labelService: LabelService;
    let mockLabelRepo: any;

    beforeEach(() => {
      mockLabelRepo = {
        findLabelsByUser: jest.fn(),
        findLabelByName: jest.fn(),
        createLabel: jest.fn(),
        findProjectLabels: jest.fn(),
        assignLabelsToProject: jest.fn(),
        removeLabelFromProject: jest.fn(),
      };
      labelService = new LabelService(mockLabelRepo as LabelRepository);
    });

    it('should create user-level project label with hex color', async () => {
      mockLabelRepo.findLabelByName.mockResolvedValue(null);
      mockLabelRepo.createLabel.mockResolvedValue({
        id: 'label-1',
        userId: 'user-1',
        name: 'Infrastructure',
        color: '#3B82F6',
      });

      const result = await labelService.createLabel('user-1', {
        name: 'Infrastructure',
        color: '#3B82F6',
      });

      expect(result.name).toBe('Infrastructure');
      expect(mockLabelRepo.createLabel).toHaveBeenCalledWith('user-1', {
        name: 'Infrastructure',
        color: '#3B82F6',
      });
    });

    it('should assign multiple project labels and return assigned list', async () => {
      mockLabelRepo.assignLabelsToProject.mockResolvedValue(undefined);
      mockLabelRepo.findProjectLabels.mockResolvedValue([
        { label: { id: 'label-1', name: 'Infra', color: '#3B82F6' } },
        { label: { id: 'label-2', name: 'AI/ML', color: '#8B5CF6' } },
      ]);

      const result = await labelService.assignLabelsToProject('proj-1', [
        'label-1',
        'label-2',
      ]);
      expect(result).toHaveLength(2);
      expect(result.map((l) => l.name)).toEqual(['Infra', 'AI/ML']);
    });
  });

  // ─── 3. Favorite Module ────────────────────────────────────────────────────
  describe('FavoriteService', () => {
    let favoriteService: FavoriteService;
    let mockFavoriteRepo: any;
    let mockPrisma: any;

    beforeEach(() => {
      mockFavoriteRepo = {
        isFavorite: jest.fn(),
        addFavorite: jest.fn(),
        removeFavorite: jest.fn(),
        findUserFavorites: jest.fn(),
        batchCheckFavorites: jest.fn(),
      };
      mockPrisma = {
        project: {
          findUnique: jest.fn().mockResolvedValue({ id: 'proj-1' }),
        },
      };
      favoriteService = new FavoriteService(mockFavoriteRepo, mockPrisma);
    });

    it('should toggle favorite status from false to true', async () => {
      mockFavoriteRepo.isFavorite.mockResolvedValue(false);
      mockFavoriteRepo.addFavorite.mockResolvedValue({
        projectId: 'proj-1',
        userId: 'user-1',
      });

      const result = await favoriteService.toggleFavorite('proj-1', 'user-1');
      expect(result.isFavorite).toBe(true);
      expect(mockFavoriteRepo.addFavorite).toHaveBeenCalledWith('proj-1', 'user-1');
    });

    it('should toggle favorite status from true to false', async () => {
      mockFavoriteRepo.isFavorite.mockResolvedValue(true);
      mockFavoriteRepo.removeFavorite.mockResolvedValue(undefined);

      const result = await favoriteService.toggleFavorite('proj-1', 'user-1');
      expect(result.isFavorite).toBe(false);
      expect(mockFavoriteRepo.removeFavorite).toHaveBeenCalledWith('proj-1', 'user-1');
    });
  });

  // ─── 4. Archive Module ─────────────────────────────────────────────────────
  describe('ArchiveService', () => {
    let archiveService: ArchiveService;
    let mockArchiveRepo: any;
    let mockCoreRepo: any;

    beforeEach(() => {
      mockArchiveRepo = {
        findProjectById: jest.fn(),
        archiveProject: jest.fn(),
        unarchiveProject: jest.fn(),
        findArchivedProjectsByUser: jest.fn(),
      };
      mockCoreRepo = {
        findMembershipsForUser: jest.fn().mockResolvedValue(new Map()),
      };
      archiveService = new ArchiveService(mockArchiveRepo, mockCoreRepo);
    });

    it('should successfully archive an active project', async () => {
      mockArchiveRepo.findProjectById.mockResolvedValue({
        id: 'proj-1',
        isArchived: false,
        name: 'Project 1',
      });
      mockArchiveRepo.archiveProject.mockResolvedValue({
        id: 'proj-1',
        isArchived: true,
        archivedAt: new Date(),
        members: [],
      });

      const result = await archiveService.archive('proj-1', 'user-1');
      expect(result.message).toBe('Project archived successfully');
      expect(result.project.isArchived).toBe(true);
    });

    it('should reject archiving an already archived project', async () => {
      mockArchiveRepo.findProjectById.mockResolvedValue({
        id: 'proj-1',
        isArchived: true,
        name: 'Project 1',
      });

      await expect(archiveService.archive('proj-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── 5. Analytics Module ───────────────────────────────────────────────────
  describe('ProjectAnalyticsService', () => {
    let analyticsService: ProjectAnalyticsService;
    let mockRepo: any;

    beforeEach(() => {
      mockRepo = {
        getProjectWithMetadata: jest.fn(),
        getWorkItemsCountsByStateGroup: jest.fn(),
        getActiveCycle: jest.fn(),
        getWorkItemsDetailed: jest.fn(),
      };
      analyticsService = new ProjectAnalyticsService(mockRepo);
    });

    it('should compute completion percentage and deadline days remaining', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);

      mockRepo.getProjectWithMetadata.mockResolvedValue({
        id: 'proj-1',
        name: 'Research Engine',
        state: ProjectState.execution,
        priority: ProjectPriority.urgent,
        startDate: new Date('2026-01-01'),
        targetDate: futureDate,
        _count: { members: 5, cycles: 2 },
      });

      mockRepo.getWorkItemsCountsByStateGroup.mockResolvedValue({
        backlog: 5,
        unstarted: 5,
        started: 10,
        completed: 30,
        cancelled: 0,
      });

      mockRepo.getActiveCycle.mockResolvedValue(null);

      const overview = await analyticsService.getProjectOverview('proj-1');
      expect(overview.totalWorkItems).toBe(50);
      expect(overview.completedWorkItems).toBe(30);
      expect(overview.completionPercentage).toBe(60); // 30 / 50 * 100
      expect(overview.isOverdue).toBe(false);
      expect(overview.daysRemaining).toBeGreaterThanOrEqual(29);
    });

    it('should compute time series data correctly for a date range', async () => {
      mockRepo.findProjectWorkItemsTimeSeries = jest.fn().mockResolvedValue([
        {
          id: 'wi-1',
          createdAt: new Date('2026-09-01T10:00:00Z'),
          updatedAt: new Date('2026-09-02T10:00:00Z'),
          completed: true,
        },
      ]);

      const series = await analyticsService.getTimeSeries(
        'proj-1',
        '2026-09-01',
        '2026-09-02',
      );
      expect(series).toHaveLength(2);
      expect(series[0].date).toBe('2026-09-01');
      expect(series[0].created).toBe(1);
      expect(series[1].date).toBe('2026-09-02');
      expect(series[1].completed).toBe(1);
    });

    it('should return sorted label distribution for a project', async () => {
      mockRepo.findProjectWorkItemsByLabel = jest.fn().mockResolvedValue([
        { id: '1', labels: ['bug', 'frontend'] },
        { id: '2', labels: ['bug'] },
      ]);

      const result = await analyticsService.getLabelDistribution('proj-1');
      expect(result.labels).toEqual([
        { label: 'bug', count: 2 },
        { label: 'frontend', count: 1 },
      ]);
    });
  });

  // ─── 6. Template Module ────────────────────────────────────────────────────
  describe('TemplateService', () => {
    let templateService: TemplateService;
    let mockRepo: any;
    let mockPrisma: any;

    beforeEach(() => {
      mockRepo = {
        findAccessibleTemplates: jest.fn(),
        findTemplateById: jest.fn(),
        createTemplate: jest.fn(),
      };
      mockPrisma = {
        $transaction: jest.fn((cb) =>
          cb({
            project: {
              create: jest.fn().mockResolvedValue({
                id: 'new-proj-id',
                name: 'Scrum Sprint Project',
                identifier: 'SCRUM',
              }),
              update: jest.fn(),
            },
            workItemState: {
              create: jest.fn().mockResolvedValue({ id: 'state-1', group: 'unstarted' }),
            },
            label: {
              create: jest.fn().mockResolvedValue({ id: 'label-1' }),
            },
            workItem: {
              create: jest.fn().mockResolvedValue({ id: 'wi-1' }),
            },
          }),
        ),
      };
      templateService = new TemplateService(mockRepo, mockPrisma);
    });

    it('should instantiate project atomically from template with initial items', async () => {
      mockRepo.findTemplateById.mockResolvedValue({
        id: 'tpl-1',
        name: 'Scrum Sprint Template',
        description: 'Template for scrum',
        avatar: '🚀',
        defaultModules: ['work_items', 'cycles'],
        initialStates: [{ group: 'unstarted', name: 'To Do' }],
        initialLabels: [{ name: 'Bug', color: '#EF4444' }],
        initialWorkItems: [{ title: 'Setup Repository', priority: 'high' }],
      });

      const project = await templateService.instantiate('tpl-1', 'user-1', {
        name: 'Scrum Sprint Project',
        identifier: 'SCRUM',
      });

      expect(project.id).toBe('new-proj-id');
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });
  });
});
