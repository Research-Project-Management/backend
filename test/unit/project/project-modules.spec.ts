import { StateService } from '@/modules/project/state/state.service';
import { StateRepository } from '@/modules/project/state/state.repository';
import { LabelService } from '@/modules/project/label/label.service';
import { LabelRepository } from '@/modules/project/label/label.repository';
import { FavoriteService } from '@/modules/project/favorite/favorite.service';
import { FavoriteRepository } from '@/modules/project/favorite/favorite.repository';
import { ArchiveService } from '@/modules/project/archive/archive.service';
import { ArchiveRepository } from '@/modules/project/archive/archive.repository';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ProjectPriority } from '@prisma/client';

describe('Project Sub-Modules Specification (Single Responsibility)', () => {
  // ─── 1. State Module ───────────────────────────────────────────────────────
  describe('StateService', () => {
    let stateService: StateService;
    let mockStateRepo: any;

    beforeEach(() => {
      mockStateRepo = {
        findProjectState: jest.fn(),
        findProjectStateById: jest.fn(),
        setCurrentProjectState: jest.fn(),
      };
      stateService = new StateService(mockStateRepo as StateRepository);
    });

    it('should return default template of 8 research project states', () => {
      const template = stateService.getDefaultStatesTemplate();
      expect(template).toHaveLength(8);
      expect(template.map((c) => c.name)).toEqual([
        'Ideation',
        'Planning',
        'Experimentation',
        'Drafting',
        'Review',
        'Published',
        'Paused',
        'Cancelled',
      ]);
    });

    it('should transition project state to target stateId', async () => {
      mockStateRepo.findProjectState.mockResolvedValue({
        id: 'proj-1',
        name: 'Genome AI',
        stateId: 'state-1',
        state: { id: 'state-1', name: 'Proposal' },
      });
      mockStateRepo.findProjectStateById.mockResolvedValue({
        id: 'state-2',
        name: 'Under Review',
      });
      mockStateRepo.setCurrentProjectState.mockResolvedValue({
        id: 'proj-1',
        stateId: 'state-2',
      });

      const result = await stateService.transitionToState('proj-1', 'state-2');
      expect(result.stateId).toBe('state-2');
      expect(result.stateLabel).toBe('Under Review');
      expect(mockStateRepo.setCurrentProjectState).toHaveBeenCalledWith(
        'proj-1',
        'state-2',
      );
    });

    it('should allow unassigning state when targetStateId is null', async () => {
      mockStateRepo.findProjectState.mockResolvedValue({
        id: 'proj-1',
        name: 'Genome AI',
        stateId: 'state-1',
      });
      mockStateRepo.setCurrentProjectState.mockResolvedValue({
        id: 'proj-1',
        stateId: null,
      });

      const result = await stateService.transitionToState('proj-1', null);
      expect(result.stateId).toBeNull();
      expect(result.state).toBeNull();
      expect(result.stateLabel).toBe('Unassigned');
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

    beforeEach(() => {
      mockFavoriteRepo = {
        isFavorite: jest.fn(),
        addFavorite: jest.fn(),
        removeFavorite: jest.fn(),
        findUserFavorites: jest.fn(),
        batchCheckFavorites: jest.fn(),
        projectExists: jest.fn().mockResolvedValue(true),
      };
      favoriteService = new FavoriteService(mockFavoriteRepo);
    });

    it('should toggle favorite status from false to true', async () => {
      mockFavoriteRepo.isFavorite.mockResolvedValue(false);
      mockFavoriteRepo.addFavorite.mockResolvedValue({
        projectId: 'proj-1',
        userId: 'user-1',
      });

      const result = await favoriteService.toggleFavorite('proj-1', 'user-1');
      expect(result.isFavorite).toBe(true);
      expect(mockFavoriteRepo.addFavorite).toHaveBeenCalledWith(
        'proj-1',
        'user-1',
      );
    });

    it('should toggle favorite status from true to false', async () => {
      mockFavoriteRepo.isFavorite.mockResolvedValue(true);
      mockFavoriteRepo.removeFavorite.mockResolvedValue(undefined);

      const result = await favoriteService.toggleFavorite('proj-1', 'user-1');
      expect(result.isFavorite).toBe(false);
      expect(mockFavoriteRepo.removeFavorite).toHaveBeenCalledWith(
        'proj-1',
        'user-1',
      );
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
        findProjectArchivedWorkItems: jest.fn().mockResolvedValue([]),
        findProjectArchivedPages: jest.fn().mockResolvedValue([]),
        restoreProjectWorkItems: jest.fn().mockResolvedValue(0),
        restoreProjectPage: jest.fn().mockResolvedValue(true),
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

    it('should return project-scoped archived work items and pages for a single project', async () => {
      mockArchiveRepo.findProjectArchivedWorkItems.mockResolvedValue([
        {
          id: 'wi-arch-1',
          identifier: 'FLUX-10',
          title: 'Archived Benchmark Task',
          priority: 'high',
          stateId: 'st-1',
          stateGroup: 'completed',
          completed: true,
          archivedAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
          projectId: 'proj-1',
          assignee: null,
        },
      ]);
      mockArchiveRepo.findProjectArchivedPages.mockResolvedValue([
        {
          id: 'page-arch-1',
          title: 'Old Literature Draft',
          description: '',
          status: 'archived',
          path: '/draft.tex',
          projectId: 'proj-1',
          version: 1,
          rev: 1,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      ]);

      const res = await archiveService.getProjectArchives('proj-1', {});
      expect(res.projectId).toBe('proj-1');
      expect(res.counts.workItems).toBe(1);
      expect(res.counts.pages).toBe(1);
      expect(res.counts.total).toBe(2);
    });
  });
});
