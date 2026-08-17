import { Test, TestingModule } from '@nestjs/testing';
import { WorkspaceService } from '@/modules/workspace/workspace.service';
import { WorkspaceRepository } from '@/modules/workspace/workspace.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';

import { BadRequestException } from '@nestjs/common';

describe('WorkspaceService', () => {
  let service: WorkspaceService;
  let repo: WorkspaceRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkspaceService,
        {
          provide: RedisCacheService,
          useValue: {
            wrap: jest.fn().mockImplementation((_key, fn) => fn()),
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            del: jest.fn().mockResolvedValue(undefined),
            delPattern: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: WorkspaceRepository,
          useValue: {
            findUserWorkspaces: jest.fn(),
            findWorkspaceByIdOrUrl: jest.fn(),
            findWorkspaceByUrl: jest.fn(),
            findWorkspaceByInviteCode: jest.fn(),
            createWorkspace: jest.fn(),
            updateWorkspace: jest.fn(),
            deleteWorkspace: jest.fn(),
            findMembers: jest.fn(),
            findMember: jest.fn(),
            countOwners: jest.fn(),
            createMember: jest.fn(),
            updateMemberRole: jest.fn(),
            deleteMember: jest.fn(),
            findUserByEmail: jest.fn(),
            searchProjects: jest.fn().mockResolvedValue([]),
            searchTasks: jest.fn().mockResolvedValue([]),
            searchPapers: jest.fn().mockResolvedValue([]),
            searchPages: jest.fn().mockResolvedValue([]),
            searchFiles: jest.fn().mockResolvedValue([]),
            searchStickies: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<WorkspaceService>(WorkspaceService);
    repo = module.get<WorkspaceRepository>(WorkspaceRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should throw BadRequestException if workspace url already taken', async () => {
    (repo.findWorkspaceByUrl as jest.Mock).mockResolvedValue({
      id: 'ws-1',
      url: 'existing-url',
    });

    await expect(
      service.createWorkspace('user-1', {
        name: 'My Workspace',
        url: 'existing-url',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should create workspace successfully with owner membership', async () => {
    (repo.findWorkspaceByUrl as jest.Mock).mockResolvedValue(null);
    (repo.createWorkspace as jest.Mock).mockResolvedValue({
      id: 'ws-new',
      name: 'New WS',
      url: 'new-ws',
      members: [{ id: 'm-1', userId: 'user-1', role: 'owner' }],
    });

    const result = await service.createWorkspace('user-1', {
      name: 'New WS',
      url: 'new-ws',
    });
    expect(result.workspace.name).toBe('New WS');
    expect(result.workspace.id).toBe('ws-new');
  });

  it('should return aggregated search results across entities in workspace', async () => {
    (repo.searchProjects as jest.Mock).mockResolvedValue([
      {
        id: 'p-1',
        name: 'AI Project',
        avatar: null,
        updatedAt: new Date('2026-01-02'),
      },
    ]);
    (repo.searchTasks as jest.Mock).mockResolvedValue([
      {
        id: 't-1',
        title: 'Task 1',
        identifier: 'T-1',
        projectId: 'p-1',
        project: { name: 'AI' },
        updatedAt: new Date('2026-01-03'),
      },
    ]);

    const results = await service.search('ws-1', 'AI');
    expect(results.length).toBe(2);
    expect(results[0].type).toBe('task');
    expect(results[1].type).toBe('project');
  });
});
