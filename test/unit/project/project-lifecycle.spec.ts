import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProjectPriority, ProjectUpdateStatus } from '@prisma/client';
import { fromPartial } from '@total-typescript/shoehorn';
import { ArchiveRepository } from '@/modules/project/archive/archive.repository';
import { ArchiveService } from '@/modules/project/archive/archive.service';
import { CoreRepository } from '@/modules/project/core/core.repository';
import { FavoriteRepository } from '@/modules/project/favorite/favorite.repository';
import { FavoriteService } from '@/modules/project/favorite/favorite.service';
import { OverviewRepository } from '@/modules/project/overview/overview.repository';
import { OverviewService } from '@/modules/project/overview/overview.service';
import { StateRepository } from '@/modules/project/state/state.repository';
import { StateService } from '@/modules/project/state/state.service';
import { StatusUpdateRepository } from '@/modules/project/status-update/status-update.repository';
import { StatusUpdateService } from '@/modules/project/status-update/status-update.service';
import { LabelRepository } from '@/modules/project/work-item/label/label.repository';
import { LabelService } from '@/modules/project/work-item/label/label.service';

describe('Project Lifecycle, Overview, States, Status Updates, Favorites & Archives', () => {
  describe('StateService (Research Lifecycle States & Transitions)', () => {
    let service: StateService;
    let mockStateRepo: jest.Mocked<StateRepository>;
    const projectId = '00000000-0000-0000-0000-000000000001';

    beforeEach(() => {
      mockStateRepo = fromPartial<jest.Mocked<StateRepository>>({
        findProjectState: jest.fn(),
        findProjectStates: jest.fn(),
        findProjectStateById: jest.fn(),
        createProjectState: jest.fn(),
        updateProjectStateItem: jest.fn(),
        reorderProjectStates: jest.fn(),
        deleteProjectState: jest.fn(),
        setCurrentProjectState: jest.fn(),
      });
      service = new StateService(mockStateRepo);
    });

    it('exposes the 8 default academic lifecycle states with valid groups, colors, and sequence 0..7', () => {
      const template = service.getDefaultStatesTemplate();
      expect(template).toHaveLength(8);
      expect(template.map((s) => s.name)).toEqual([
        'Ideation',
        'Planning',
        'Experimentation',
        'Drafting',
        'Review',
        'Published',
        'Paused',
        'Cancelled',
      ]);
      expect(template[0].isDefault).toBe(true);
      expect(template.slice(1).every((s) => !s.isDefault)).toBe(true);
      template.forEach((s, idx) => {
        expect(s.color).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(s.sequence).toBe(idx);
      });
      expect(template.find((s) => s.name === 'Ideation')?.group).toBe('conception');
      expect(template.find((s) => s.name === 'Experimentation')?.group).toBe('execution');
      expect(template.find((s) => s.name === 'Review')?.group).toBe('review');
      expect(template.find((s) => s.name === 'Published')?.group).toBe('completed');
      expect(template.find((s) => s.name === 'Cancelled')?.group).toBe('suspended');
    });

    it('retrieves current state, transitions to target or null unassigned state, and handles custom state CRUD + reorder', async () => {
      mockStateRepo.findProjectState.mockResolvedValueOnce(
        fromPartial({
          id: projectId,
          name: 'Test Project',
          stateId: 'state-1',
          state: { id: 'state-1', name: 'Proposal', color: '#0284c7', sequence: 0 },
        }),
      );
      await expect(service.getProjectCurrentState(projectId)).resolves.toMatchObject({
        projectId,
        stateId: 'state-1',
        stateLabel: 'Proposal',
      });

      mockStateRepo.findProjectState.mockResolvedValueOnce(
        fromPartial({ id: projectId, name: 'Unassigned', stateId: null, state: null }),
      );
      await expect(service.getProjectCurrentState(projectId)).resolves.toMatchObject({
        stateId: null,
        stateLabel: 'Unassigned',
      });

      mockStateRepo.findProjectState.mockResolvedValueOnce(null);
      await expect(service.getProjectCurrentState('missing')).rejects.toThrow(
        NotFoundException,
      );

      // Transitions
      mockStateRepo.findProjectState.mockResolvedValue(
        fromPartial({ id: projectId, name: 'Test Project', stateId: 'state-1' }),
      );
      mockStateRepo.findProjectStateById.mockResolvedValueOnce(
        fromPartial({ id: 'state-2', name: 'Active Experimentation' }),
      );
      await expect(
        service.transitionToState(projectId, 'state-2'),
      ).resolves.toMatchObject({
        stateId: 'state-2',
        stateLabel: 'Active Experimentation',
      });

      await expect(service.transitionToState(projectId, null)).resolves.toMatchObject({
        stateId: null,
        stateLabel: 'Unassigned',
      });

      mockStateRepo.findProjectStateById.mockResolvedValueOnce(null);
      await expect(
        service.transitionToState(projectId, 'invalid'),
      ).rejects.toThrow(NotFoundException);

      // Custom CRUD & reorder
      mockStateRepo.createProjectState.mockResolvedValueOnce(
        fromPartial({ id: 's-new', name: 'Field Trip', sequence: 2 }),
      );
      await expect(
        service.createCustomState(projectId, {
          name: 'Field Trip',
          color: '#0284c7',
          description: 'Soil sampling',
        }),
      ).resolves.toMatchObject({ id: 's-new', name: 'Field Trip' });

      mockStateRepo.reorderProjectStates.mockResolvedValueOnce([
        fromPartial({ id: 's2', sequence: 0 }),
        fromPartial({ id: 's1', sequence: 1 }),
      ]);
      const reordered = await service.reorderStates(projectId, {
        states: [
          { id: 's2', sequence: 0 },
          { id: 's1', sequence: 1 },
        ],
      });
      expect(reordered[0].id).toBe('s2');

      mockStateRepo.findProjectStateById.mockResolvedValueOnce(
        fromPartial({ id: 's1', name: 'Proposal', projectId }),
      );
      await expect(
        service.deleteCustomState(projectId, 's1'),
      ).resolves.toMatchObject({
        success: true,
      });
    });
  });

  describe('StatusUpdateService & OverviewService', () => {
    it('manages project status updates and enforces project ownership on update/delete', async () => {
      const repo = fromPartial<jest.Mocked<StatusUpdateRepository>>({
        findManyByProjectId: jest.fn().mockResolvedValue([
          {
            id: 'u-1',
            projectId: 'p-1',
            status: ProjectUpdateStatus.on_track,
            message: 'On track',
            createdById: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
            createdBy: { id: 'user-1', profile: { name: 'Alice', avatar: null } },
          },
        ]),
        findLatestByProjectId: jest.fn().mockResolvedValue({
          id: 'u-1',
          projectId: 'p-1',
          status: ProjectUpdateStatus.off_track,
          message: 'Critical blocker',
          createdById: 'user-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: { id: 'user-1', profile: { name: 'Alice', avatar: null } },
        }),
        create: jest.fn(async (projectId, userId, dto) => ({
          id: 'u-3',
          projectId,
          status: dto.status,
          message: dto.message,
          createdById: userId,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: { id: userId, profile: { name: 'Alice', avatar: null } },
        })),
        findById: jest.fn(),
        update: jest.fn(async (_id, dto) => ({
          id: 'u-1',
          projectId: 'p-1',
          status: dto.status ?? ProjectUpdateStatus.at_risk,
          message: dto.message ?? 'Updated',
          createdById: 'user-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: { id: 'user-1', profile: { name: 'Alice', avatar: null } },
        })),
        delete: jest.fn().mockResolvedValue({}),
      });
      const service = new StatusUpdateService(repo);

      const list = await service.getUpdates('p-1');
      expect(list[0].author.name).toBe('Alice');

      const latest = await service.getLatestUpdate('p-1');
      expect(latest?.status).toBe(ProjectUpdateStatus.off_track);

      const created = await service.createUpdate('p-1', 'user-1', {
        status: ProjectUpdateStatus.on_track,
        message: 'Phase 1 done',
      });
      expect(created.id).toBe('u-3');

      repo.findById.mockResolvedValueOnce(null);
      await expect(
        service.updateUpdate('p-1', 'unknown', { message: 'test' }),
      ).rejects.toThrow(NotFoundException);

      repo.findById.mockResolvedValue(fromPartial({ id: 'u-1', projectId: 'p-1' }));
      const updated = await service.updateUpdate('p-1', 'u-1', {
        status: ProjectUpdateStatus.at_risk,
        message: 'Updated message',
      });
      expect(updated.status).toBe(ProjectUpdateStatus.at_risk);

      await expect(service.deleteUpdate('p-1', 'u-1')).resolves.toEqual({
        success: true,
      });
    });

    it('aggregates project overview metrics, completion percentage, activities, and assets', async () => {
      const overviewRepo = fromPartial<jest.Mocked<OverviewRepository>>({
        getProjectMetadata: jest.fn().mockResolvedValue({
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
            name: 'Experimentation',
            description: null,
            color: '#d97706',
            sequence: 3,
            isDefault: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          priority: ProjectPriority.urgent,
          startDate: new Date('2026-01-01'),
          targetDate: new Date('2026-12-31'),
          createdBy: { id: 'u-1', profile: { name: 'Dr. John', avatar: null } },
          members: [
            {
              userId: 'u-1',
              role: 'owner',
              user: { id: 'u-1', profile: { name: 'Dr. John', avatar: null } },
            },
          ],
          _count: { members: 5 },
        }),
        getWorkItemStateGroupCounts: jest.fn().mockResolvedValue({
          backlog: 5,
          unstarted: 5,
          started: 10,
          completed: 20,
          cancelled: 2,
        }),
        getOverdueCount: jest.fn().mockResolvedValue(3),
        getLatestStatusUpdate: jest.fn().mockResolvedValue({
          id: 'update-1',
          status: 'on_track',
          message: 'On track',
          createdAt: new Date(),
          createdBy: { id: 'u-1', profile: { name: 'Dr. John', avatar: null } },
        }),
        getRecentActivities: jest.fn().mockResolvedValue([
          {
            id: 'act-1',
            verb: 'updated',
            field: 'state',
            oldValue: 'Started',
            newValue: 'Completed',
            oldIdentifier: null,
            newIdentifier: null,
            createdAt: new Date(),
            actor: { id: 'u-3', profile: { name: 'Bob', avatar: null } },
          },
        ]),
        getProjectAssets: jest.fn().mockResolvedValue({
          pagesCount: 3,
          libraryCount: 7,
          filesCount: 12,
        }),
      });
      const service = new OverviewService(overviewRepo);

      const overview = await service.getProjectOverview('proj-1');
      expect(overview.project.lead?.name).toBe('Dr. John');
      expect(overview.metrics).toMatchObject({
        totalIssues: 42,
        completed: 20,
        overdue: 3,
        completionPercentage: 50.0,
      });
      expect(overview.assets).toEqual({
        pagesCount: 3,
        libraryCount: 7,
        filesCount: 12,
      });

      overviewRepo.getProjectMetadata.mockResolvedValueOnce(null);
      await expect(service.getProjectOverview('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('FavoriteService, ArchiveService & LabelService', () => {
    it('toggles favorites, archives active projects, lists project-scoped archives, and manages taxonomy labels', async () => {
      const favRepo = fromPartial<jest.Mocked<FavoriteRepository>>({
        isFavorite: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
        addFavorite: jest.fn(),
        removeFavorite: jest.fn(),
        projectExists: jest.fn().mockResolvedValue(true),
      });
      const favService = new FavoriteService(favRepo);
      await expect(favService.toggleFavorite('proj-1', 'user-1')).resolves.toEqual({
        isFavorite: true,
      });
      await expect(favService.toggleFavorite('proj-1', 'user-1')).resolves.toEqual({
        isFavorite: false,
      });

      const archiveRepo = fromPartial<jest.Mocked<ArchiveRepository>>({
        findProjectById: jest
          .fn()
          .mockResolvedValueOnce(
            fromPartial({ id: 'proj-1', isArchived: false, name: 'Project 1' }),
          )
          .mockResolvedValueOnce(
            fromPartial({ id: 'proj-1', isArchived: true, name: 'Project 1' }),
          ),
        archiveProject: jest.fn().mockResolvedValue(
          fromPartial({
            id: 'proj-1',
            isArchived: true,
            archivedAt: new Date(),
            members: [],
          }),
        ),
        findProjectArchivedWorkItems: jest.fn().mockResolvedValue([
          fromPartial({ id: 'wi-arch-1', identifier: 'FLUX-10', projectId: 'proj-1' }),
        ]),
        findProjectArchivedPages: jest.fn().mockResolvedValue([
          fromPartial({ id: 'page-arch-1', title: 'Draft', projectId: 'proj-1' }),
        ]),
      });
      const archiveService = new ArchiveService(
        archiveRepo,
        fromPartial<CoreRepository>({
          findMembershipsForUser: jest.fn().mockResolvedValue(new Map()),
        }),
      );

      const archived = await archiveService.archive('proj-1', 'user-1');
      expect(archived.project.isArchived).toBe(true);
      await expect(archiveService.archive('proj-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );

      const scopedArchives = await archiveService.getProjectArchives('proj-1', {});
      expect(scopedArchives.counts).toEqual({ workItems: 1, pages: 1, total: 2 });

      const labelService = new LabelService(
        fromPartial<LabelRepository>({
          findProject: jest.fn().mockResolvedValue({ id: 'proj-1' }),
          findByNameInProject: jest.fn().mockResolvedValue(null),
          getLastSortOrder: jest.fn().mockResolvedValue(10000),
          create: jest.fn().mockResolvedValue({
            id: 'label-1',
            name: 'Deep Learning',
            color: '#3B82F6',
            description: 'Neural operator models',
            sortOrder: 20000,
            spaceId: 'proj-1',
          }),
          findProjectLabels: jest.fn().mockResolvedValue([
            { id: 'label-1', name: 'Deep Learning', color: '#3B82F6' },
          ]),
        }),
      );
      const createdLabel = await labelService.createProjectLabel(
        'proj-1',
        'user-1',
        {
          name: 'Deep Learning',
          color: '#3B82F6',
          description: 'Neural operator models',
        },
      );
      expect(createdLabel.label.name).toBe('Deep Learning');
      const labelsList = await labelService.getProjectLabels('proj-1');
      expect(labelsList.labels).toHaveLength(1);
    });
  });
});
