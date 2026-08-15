import { Test, TestingModule } from '@nestjs/testing';
import { ProjectService } from '@/modules/organization/project/project.service';
import { ProjectRepository } from '@/modules/organization/project/project.repository';
import { NotFoundException } from '@nestjs/common';

describe('ProjectService', () => {
  let service: ProjectService;
  let repo: ProjectRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectService,
        {
          provide: ProjectRepository,
          useValue: {
            findWorkspaceProjects: jest.fn(),
            findProjectById: jest.fn(),
            createProject: jest.fn(),
            updateProject: jest.fn(),
            findProjectMembers: jest.fn(),
            findProjectMember: jest.fn(),
            createProjectMember: jest.fn(),
            updateProjectMemberRole: jest.fn(),
            deleteProjectMember: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ProjectService>(ProjectService);
    repo = module.get<ProjectRepository>(ProjectRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create project successfully with owner membership', async () => {
    (repo.createProject as jest.Mock).mockResolvedValue({
      id: 'proj-1',
      name: 'Paper Project',
      workspaceId: 'ws-1',
      members: [{ id: 'pm-1', userId: 'user-1', role: 'owner' }],
    });

    const result = await service.createProject('ws-1', 'user-1', {
      name: 'Paper Project',
    });
    expect(result.project.name).toBe('Paper Project');
    expect(result.project.id).toBe('proj-1');
  });

  it('should throw NotFoundException if project not found', async () => {
    (repo.findProjectById as jest.Mock).mockResolvedValue(null);

    await expect(service.getProject('non-existing-proj')).rejects.toThrow(
      NotFoundException,
    );
  });
});
