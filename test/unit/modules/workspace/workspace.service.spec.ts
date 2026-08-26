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

describe('WorkspaceService', () => {
  let service: WorkspaceService;
  let repo: jest.Mocked<WorkspaceRepository>;
  let invitationRepo: jest.Mocked<WorkspaceInvitationRepository>;
  let cache: jest.Mocked<RedisCacheService>;

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
            findById: jest.fn(),
            findBySlug: jest.fn(),
            findByIdOrSlug: jest.fn(),
            findByInviteCode: jest.fn(),
            createWorkspace: jest.fn(),
            updateWorkspace: jest.fn(),
            softDeleteWorkspace: jest.fn(),
            restoreWorkspace: jest.fn(),
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
        {
          provide: WorkspaceInvitationRepository,
          useValue: {
            createInvitation: jest.fn(),
            findByToken: jest.fn(),
            updateStatus: jest.fn(),
            listPendingByWorkspace: jest.fn(),
            revokeInvitation: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WorkspaceService>(WorkspaceService);
    repo = module.get(WorkspaceRepository);
    invitationRepo = module.get(WorkspaceInvitationRepository);
    cache = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createWorkspace', () => {
    it('should throw BadRequestException if workspace slug/url already taken', async () => {
      repo.findBySlug.mockResolvedValue({
        id: 'ws-1',
        name: 'Existing',
        slug: 'existing-slug',
        url: 'existing-slug',
      } as any);

      await expect(
        service.createWorkspace('user-1', {
          name: 'My Workspace',
          slug: 'existing-slug',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create workspace successfully with owner membership', async () => {
      repo.findBySlug.mockResolvedValue(null);
      repo.createWorkspace.mockResolvedValue({
        id: 'ws-new',
        name: 'New WS',
        slug: 'new-ws',
        url: 'new-ws',
        members: [
          { id: 'm-1', userId: 'user-1', role: WorkspaceMemberRole.owner },
        ],
      } as any);

      const result = await service.createWorkspace('user-1', {
        name: 'New WS',
        slug: 'new-ws',
      });
      expect(result.workspace.name).toBe('New WS');
      expect(result.workspace.id).toBe('ws-new');
      expect(cache.del).toHaveBeenCalled();
    });
  });

  describe('getWorkspace', () => {
    it('should resolve workspace and return current user role', async () => {
      repo.findByIdOrSlug.mockResolvedValue({
        id: 'ws-1',
        name: 'Quantum Lab',
        slug: 'quantum-lab',
        members: [{ userId: 'user-1', role: WorkspaceMemberRole.admin }],
      } as any);

      const result = await service.getWorkspace('quantum-lab', 'user-1');
      expect(result.workspace.name).toBe('Quantum Lab');
      expect(result.yourRole).toBe(WorkspaceMemberRole.admin);
    });

    it('should throw NotFoundException if workspace not found', async () => {
      repo.findByIdOrSlug.mockResolvedValue(null);
      await expect(service.getWorkspace('unknown', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('leaveWorkspace & removeMember Single-Owner Protection', () => {
    it('should forbid the only owner from leaving the workspace', async () => {
      repo.findMember.mockResolvedValue({
        id: 'm-1',
        workspaceId: 'ws-1',
        userId: 'user-1',
        role: WorkspaceMemberRole.owner,
      } as any);
      repo.countOwners.mockResolvedValue(1);

      await expect(service.leaveWorkspace('ws-1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should forbid removing the only owner of the workspace', async () => {
      repo.findMember.mockResolvedValue({
        id: 'm-1',
        workspaceId: 'ws-1',
        userId: 'user-owner',
        role: WorkspaceMemberRole.owner,
      } as any);
      repo.countOwners.mockResolvedValue(1);

      await expect(service.removeMember('ws-1', 'user-owner')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should allow leaving if there is more than 1 owner', async () => {
      repo.findMember.mockResolvedValue({
        id: 'm-1',
        workspaceId: 'ws-1',
        userId: 'user-1',
        role: WorkspaceMemberRole.owner,
      } as any);
      repo.countOwners.mockResolvedValue(2);
      repo.deleteMember.mockResolvedValue(undefined);

      const result = await service.leaveWorkspace('ws-1', 'user-1');
      expect(result.message).toContain('Left workspace successfully');
    });
  });

  describe('Invitations Lifecycle', () => {
    it('should create an invitation and evict pending invitation cache', async () => {
      repo.findById.mockResolvedValue({ id: 'ws-1', name: 'WS' } as any);
      invitationRepo.createInvitation.mockResolvedValue({
        id: 'inv-1',
        email: 'collaborator@lab.org',
        role: WorkspaceMemberRole.member,
        token: 'token-123',
        status: 'pending',
      } as any);

      const result = await service.createInvitation('ws-1', 'admin-1', {
        email: 'collaborator@lab.org',
        role: WorkspaceMemberRole.member,
      });

      expect(result.invitation.id).toBe('inv-1');
      expect(cache.del).toHaveBeenCalledWith('flux:ws:invitations:ws-1');
    });

    it('should accept valid invitation and add member to workspace', async () => {
      invitationRepo.findByToken.mockResolvedValue({
        id: 'inv-1',
        workspaceId: 'ws-1',
        email: 'user@example.com',
        role: WorkspaceMemberRole.member,
        token: 'token-123',
        status: 'pending',
        invitedById: 'admin-1',
        expiresAt: new Date(Date.now() + 86400000), // tomorrow
        acceptedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        workspace: { id: 'ws-1', name: 'WS', url: 'ws' },
        invitedBy: {
          id: 'admin-1',
          name: 'Admin',
          email: 'admin@ws.com',
          avatar: null,
        },
      } as any);
      repo.findMember.mockResolvedValue(null);
      repo.createMember.mockResolvedValue({ id: 'm-new' } as any);
      invitationRepo.updateStatus.mockResolvedValue({
        id: 'inv-1',
        status: 'accepted',
      } as any);

      const result = await service.acceptInvitation('user-new', 'token-123');
      expect(result.message).toContain('Invitation accepted successfully');
      expect(repo.createMember).toHaveBeenCalledWith(
        'ws-1',
        'user-new',
        WorkspaceMemberRole.member,
      );
      expect(invitationRepo.updateStatus).toHaveBeenCalledWith(
        'inv-1',
        'accepted',
        expect.any(Date),
      );
    });

    it('should reject expired invitation', async () => {
      invitationRepo.findByToken.mockResolvedValue({
        id: 'inv-1',
        workspaceId: 'ws-1',
        email: 'user@example.com',
        role: WorkspaceMemberRole.member,
        token: 'token-123',
        status: 'pending',
        invitedById: 'admin-1',
        expiresAt: new Date(Date.now() - 86400000), // yesterday (expired)
        acceptedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        workspace: { id: 'ws-1', name: 'WS', url: 'ws' },
        invitedBy: {
          id: 'admin-1',
          name: 'Admin',
          email: 'admin@ws.com',
          avatar: null,
        },
      } as any);

      await expect(
        service.acceptInvitation('user-new', 'token-123'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('search', () => {
    it('should return aggregated search results across entities in workspace', async () => {
      repo.findByIdOrSlug.mockResolvedValue({
        id: 'ws-1',
        name: 'Workspace 1',
        members: [{ userId: 'user-1', role: 'owner' }],
      } as any);

      repo.searchProjects.mockResolvedValue([
        {
          id: 'p-1',
          name: 'AI Project',
          avatar: null,
          updatedAt: new Date('2026-01-02'),
        },
      ]);

      const results = await service.search('ws-1', 'AI', 'user-1');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('project');
      expect(results[0].name).toBe('AI Project');
    });
  });
});
