import { Test, TestingModule } from '@nestjs/testing';
import { ProjectService } from '@/modules/project/project.service';
import { ProjectRepository } from '@/modules/project/project.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ProjectMemberRole } from '@prisma/client';

describe('ProjectService', () => {
  let service: ProjectService;
  let repo: jest.Mocked<ProjectRepository>;
  let eventEmitter: EventEmitter2;
  let cache: jest.Mocked<RedisCacheService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectService,
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
        {
          provide: RedisCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
            delPattern: jest.fn(),
            wrap: jest.fn((key, fn) => fn()),
          },
        },
        {
          provide: ProjectRepository,
          useValue: {
            findWorkspaceProjects: jest.fn(),
            findProjectById: jest.fn(),
            findProjectByIdentifier: jest.fn(),
            resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
            createProject: jest.fn(),
            updateProject: jest.fn(),
            softDeleteProject: jest.fn(),
            restoreProject: jest.fn(),
            deleteProject: jest.fn(),
            findProjectMembers: jest.fn(),
            findProjectMember: jest.fn(),
            createProjectMember: jest.fn(),
            updateProjectMemberRole: jest.fn(),
            deleteProjectMember: jest.fn(),
            findProjectOverview: jest.fn(),
            countAdmins: jest.fn(),
            deleteColumnWithTaskMigration: jest
              .fn()
              .mockResolvedValue({ id: 'proj-1' }),
          },
        },
      ],
    }).compile();

    service = module.get<ProjectService>(ProjectService);
    repo = module.get(ProjectRepository);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    cache = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createProject', () => {
    it('should create project with identifier and assign admin role', async () => {
      repo.findProjectByIdentifier.mockResolvedValue(null);
      repo.createProject.mockResolvedValue({
        id: 'proj-1',
        name: 'Neural AI',
        identifier: 'NEURO',
        workspaceId: 'ws-1',
        members: [
          {
            id: 'pm-1',
            userId: 'user-1',
            role: ProjectMemberRole.admin,
          } as any,
        ],
      } as any);

      const result = await service.createProject('ws-1', 'user-1', {
        name: 'Neural AI',
        identifier: 'neuro',
      });

      expect(result.project.name).toBe('Neural AI');
      expect(repo.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Neural AI',
          identifier: 'NEURO',
        }),
      );
      expect(cache.del).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'project.created',
        expect.any(Object),
      );
    });

    it('should throw BadRequestException if identifier is already taken in workspace', async () => {
      repo.findProjectByIdentifier.mockResolvedValue({
        id: 'proj-other',
      } as any);

      await expect(
        service.createProject('ws-1', 'user-1', {
          name: 'Neural AI',
          identifier: 'NEURO',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getProjectOverview', () => {
    it('should get project overview with stats and caller role', async () => {
      repo.findProjectOverview.mockResolvedValue({
        project: {
          id: 'proj-1',
          name: 'Project 1',
          members: [{ userId: 'u-1', role: ProjectMemberRole.admin }],
        },
        stats: {
          files: { count: 1, totalSize: 100, recent: [] },
          tasks: { total: 5, completed: 2, pending: 2, inProgress: 1 },
          members: 1,
        },
      });

      const result = await service.getProjectOverview('proj-1', 'u-1');

      expect(result.stats.tasks.total).toBe(5);
      expect(result.yourRole).toBe(ProjectMemberRole.admin);
    });
  });

  describe('Single-Admin Safety Invariant', () => {
    it('should prevent removing the only admin of a project', async () => {
      repo.findProjectMember.mockResolvedValue({
        id: 'pm-1',
        projectId: 'proj-1',
        userId: 'admin-1',
        role: ProjectMemberRole.admin,
      } as any);
      repo.countAdmins.mockResolvedValue(1);

      await expect(
        service.removeProjectMember('proj-1', 'admin-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow removing an admin if there are multiple admins', async () => {
      repo.findProjectMember.mockResolvedValue({
        id: 'pm-1',
        projectId: 'proj-1',
        userId: 'admin-1',
        role: ProjectMemberRole.admin,
      } as any);
      repo.countAdmins.mockResolvedValue(2);
      repo.deleteProjectMember.mockResolvedValue(undefined);

      const result = await service.removeProjectMember('proj-1', 'admin-1');
      expect(result.message).toContain('removed successfully');
      expect(repo.deleteProjectMember).toHaveBeenCalledWith(
        'proj-1',
        'admin-1',
      );
    });

    it('should prevent demoting the only admin of a project', async () => {
      repo.findProjectMember.mockResolvedValue({
        id: 'pm-1',
        projectId: 'proj-1',
        userId: 'admin-1',
        role: ProjectMemberRole.admin,
      } as any);
      repo.countAdmins.mockResolvedValue(1);

      await expect(
        service.updateProjectMember('proj-1', 'admin-1', {
          role: ProjectMemberRole.contributor,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Soft-delete and Restore', () => {
    it('should soft delete project and invalidate cache', async () => {
      repo.findProjectById.mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-1',
      } as any);
      repo.softDeleteProject.mockResolvedValue({ id: 'proj-1' } as any);

      const result = await service.deleteProject('proj-1');
      expect(result.message).toContain('soft-deleted successfully');
      expect(repo.softDeleteProject).toHaveBeenCalledWith('proj-1');
      expect(cache.del).toHaveBeenCalled();
    });

    it('should restore soft-deleted project', async () => {
      repo.restoreProject.mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-1',
      } as any);

      const result = await service.restoreProject('proj-1');
      expect(result.message).toContain('restored successfully');
      expect(repo.restoreProject).toHaveBeenCalledWith('proj-1');
    });
  });

  describe('Kanban Column Safe Deletion', () => {
    it('should prevent deleting the only remaining column in a project', async () => {
      repo.findProjectById.mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-1',
        taskColumns: [{ id: 'backlog', title: 'Backlog' }],
      } as any);

      await expect(service.deleteColumn('proj-1', 'backlog')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should atomically migrate tasks to default remaining column when deleting a column', async () => {
      repo.findProjectById.mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-1',
        taskColumns: [
          { id: 'todo', title: 'To Do' },
          { id: 'doing', title: 'Doing' },
          { id: 'done', title: 'Done' },
        ],
      } as any);

      const result = await service.deleteColumn('proj-1', 'doing');

      expect(result.migratedTo).toBe('todo');
      expect(result.columns).toHaveLength(2);
      expect(repo.deleteColumnWithTaskMigration).toHaveBeenCalledWith(
        'proj-1',
        'doing',
        'todo',
        expect.any(Array),
      );
      expect(cache.del).toHaveBeenCalled();
    });

    it('should migrate tasks to specified fallback column when provided', async () => {
      repo.findProjectById.mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-1',
        taskColumns: [
          { id: 'todo', title: 'To Do' },
          { id: 'doing', title: 'Doing' },
          { id: 'done', title: 'Done' },
        ],
      } as any);

      const result = await service.deleteColumn('proj-1', 'doing', 'done');

      expect(result.migratedTo).toBe('done');
      expect(repo.deleteColumnWithTaskMigration).toHaveBeenCalledWith(
        'proj-1',
        'doing',
        'done',
        expect.any(Array),
      );
    });
  });
});
