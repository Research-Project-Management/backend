import { Test, TestingModule } from '@nestjs/testing';
import { WorkspaceService } from '@/modules/workspace/workspace.service';
import { WorkspaceRepository } from '@/modules/workspace/workspace.repository';
import { WorkspaceInvitationRepository } from '@/modules/workspace/workspace-invitation.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { WorkspaceMemberRole } from '@prisma/client';

describe('WorkspaceService - Global Search Tenant Isolation (P0-1 Fix)', () => {
  let service: WorkspaceService;
  let workspaceRepo: jest.Mocked<WorkspaceRepository>;

  beforeEach(async () => {
    const mockRepo = {
      findByIdOrSlug: jest.fn(),
      findMember: jest.fn(),
      searchProjects: jest.fn().mockResolvedValue([]),
      searchTasks: jest.fn().mockResolvedValue([]),
      searchPapers: jest.fn().mockResolvedValue([]),
      searchPages: jest.fn().mockResolvedValue([]),
      searchFiles: jest.fn().mockResolvedValue([]),
      searchStickies: jest.fn().mockResolvedValue([]),
    };

    const mockInvitationRepo = {};
    const mockCache = {
      wrap: jest.fn(),
      del: jest.fn(),
      delPattern: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkspaceService,
        { provide: WorkspaceRepository, useValue: mockRepo },
        {
          provide: WorkspaceInvitationRepository,
          useValue: mockInvitationRepo,
        },
        { provide: RedisCacheService, useValue: mockCache },
      ],
    }).compile();

    service = module.get<WorkspaceService>(WorkspaceService);
    workspaceRepo = module.get(WorkspaceRepository);
  });

  it('rejects search when workspaceId is missing or empty', async () => {
    await expect(service.search('', 'test', 'user-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('returns empty array when query is empty without querying DB', async () => {
    const res = await service.search('ws-1', '', 'user-1');
    expect(res).toEqual([]);
    expect(workspaceRepo.searchProjects).not.toHaveBeenCalled();
  });

  it('throws NotFoundException if workspace does not exist', async () => {
    workspaceRepo.findByIdOrSlug.mockResolvedValue(null);

    await expect(
      service.search('ws-ghost', 'neural', 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException if user is NOT a member of the workspace (IDOR prevention)', async () => {
    workspaceRepo.findByIdOrSlug.mockResolvedValue({
      id: 'ws-target',
      name: 'Target Org',
      url: 'target-org',
      slug: 'target-org',
      members: [],
    } as any);
    workspaceRepo.findMember.mockResolvedValue(null);

    await expect(
      service.search('ws-target', 'sensitive', 'attacker-user'),
    ).rejects.toThrow(ForbiddenException);
    expect(workspaceRepo.searchProjects).not.toHaveBeenCalled();
  });

  it('executes search and aggregates results when user is a verified member', async () => {
    workspaceRepo.findByIdOrSlug.mockResolvedValue({
      id: 'ws-allowed',
      name: 'Allowed Org',
      url: 'allowed-org',
      slug: 'allowed-org',
      members: [{ userId: 'user-1', role: WorkspaceMemberRole.member }],
    } as any);

    workspaceRepo.searchProjects.mockResolvedValue([
      {
        id: 'p-1',
        name: 'AI Research',
        avatar: null,
        updatedAt: new Date('2026-01-01'),
      },
    ]);

    const results = await service.search('ws-allowed', 'research', 'user-1');
    expect(results.length).toBe(1);
    expect(results[0]).toEqual({
      type: 'project',
      id: 'p-1',
      name: 'AI Research',
      icon: null,
      updatedAt: expect.any(Date),
    });
    expect(workspaceRepo.searchProjects).toHaveBeenCalledWith(
      'ws-allowed',
      'research',
    );
  });
});
