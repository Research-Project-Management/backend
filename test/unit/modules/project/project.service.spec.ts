import { Test, TestingModule } from '@nestjs/testing';
import { ProjectService } from '@/modules/project/project.service';
import { ProjectRepository } from '@/modules/project/project.repository';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('ProjectService', () => {
  let service: ProjectService;
  let repo: ProjectRepository;
  let eventEmitter: EventEmitter2;

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
          provide: ProjectRepository,
          useValue: {
            findWorkspaceProjects: jest.fn(),
            findProjectById: jest.fn(),
            resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
            createProject: jest.fn(),
            updateProject: jest.fn(),
            findProjectMembers: jest.fn(),
            findProjectMember: jest.fn(),
            createProjectMember: jest.fn(),
            updateProjectMemberRole: jest.fn(),
            deleteProjectMember: jest.fn(),
            findProjectOverview: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ProjectService>(ProjectService);
    repo = module.get<ProjectRepository>(ProjectRepository);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should get project overview with stats and caller role', async () => {
    (repo.findProjectOverview as jest.Mock).mockResolvedValue({
      project: {
        id: 'proj-1',
        name: 'Project 1',
        members: [{ userId: 'u-1', role: 'admin' }],
      },
      stats: {
        files: { count: 1, totalSize: 100, recent: [] },
        tasks: { total: 5, completed: 2, pending: 2, inProgress: 1 },
        members: 1,
      },
    });

    const result = await service.getProjectOverview('proj-1', 'u-1');

    expect(result.stats.tasks.total).toBe(5);
    expect(result.yourRole).toBe('admin');
  });

  it('should create project successfully and emit project.created event', async () => {
    (repo.createProject as jest.Mock).mockResolvedValue({
      id: 'proj-1',
      name: 'Paper Project',
      workspaceId: 'ws-1',
      members: [{ id: 'pm-1', userId: 'user-1', role: 'admin' }],
    });

    const result = await service.createProject('ws-1', 'user-1', {
      name: 'Paper Project',
    });
    expect(result.project.name).toBe('Paper Project');
    expect(result.project.id).toBe('proj-1');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'project.created',
      expect.objectContaining({
        workspaceId: 'ws-1',
        projectId: 'proj-1',
      }),
    );
  });

  it('should throw NotFoundException if project not found', async () => {
    (repo.findProjectById as jest.Mock).mockResolvedValue(null);

    await expect(service.getProject('non-existing-proj')).rejects.toThrow(
      NotFoundException,
    );
  });

  describe('addProjectMember', () => {
    it('should default role to contributor when role is not provided', async () => {
      (repo.findProjectMember as jest.Mock).mockResolvedValue(null);
      (repo.createProjectMember as jest.Mock).mockResolvedValue({
        id: 'pm-1',
        projectId: 'proj-1',
        userId: 'user-2',
        role: 'contributor',
      });

      const result = await service.addProjectMember('proj-1', {
        userId: 'user-2',
      });

      expect(repo.createProjectMember).toHaveBeenCalledWith(
        'proj-1',
        'user-2',
        'contributor',
      );
      expect(result.member.role).toBe('contributor');
    });

    it('should throw BadRequestException if invalid project role like "member" or "owner" is provided', async () => {
      (repo.findProjectMember as jest.Mock).mockResolvedValue(null);

      await expect(
        service.addProjectMember('proj-1', {
          userId: 'user-2',
          role: 'member' as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
