import { Test, TestingModule } from '@nestjs/testing';
import { AuthzService } from '@/modules/iam/authz/authz.service';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { Permission } from '@/modules/iam/authz/enums/permissions.enum';
import { WorkspaceRole } from '@/modules/iam/authz/enums/workspace-role.enum';
import { ProjectRole } from '@/modules/iam/authz/enums/project-role.enum';

describe('AuthzService', () => {
  let service: AuthzService;
  let prisma: any;
  let redis: jest.Mocked<RedisCacheService>;

  beforeEach(async () => {
    prisma = {
      workspaceMember: {
        findUnique: jest.fn(),
      },
      projectMember: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthzService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: RedisCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthzService>(AuthzService);
    redis = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('hasWorkspacePermission', () => {
    it('should grant all permissions to workspace owner', () => {
      expect(
        service.hasWorkspacePermission(
          WorkspaceRole.OWNER,
          Permission.WORKSPACE_DELETE,
        ),
      ).toBe(true);
      expect(
        service.hasWorkspacePermission(
          WorkspaceRole.OWNER,
          Permission.PROJECT_CREATE,
        ),
      ).toBe(true);
    });

    it('should grant project create but deny workspace delete to workspace admin', () => {
      expect(
        service.hasWorkspacePermission(
          WorkspaceRole.ADMIN,
          Permission.PROJECT_CREATE,
        ),
      ).toBe(true);
      expect(
        service.hasWorkspacePermission(
          WorkspaceRole.ADMIN,
          Permission.WORKSPACE_DELETE,
        ),
      ).toBe(false);
    });

    it('should deny project create to workspace viewer', () => {
      expect(
        service.hasWorkspacePermission(
          WorkspaceRole.VIEWER,
          Permission.PROJECT_CREATE,
        ),
      ).toBe(false);
      expect(
        service.hasWorkspacePermission(
          WorkspaceRole.VIEWER,
          Permission.WORKSPACE_VIEW,
        ),
      ).toBe(true);
    });
  });

  describe('hasProjectPermission', () => {
    it('should grant project edit to project admin', () => {
      expect(
        service.hasProjectPermission(
          ProjectRole.ADMIN,
          Permission.PROJECT_EDIT,
        ),
      ).toBe(true);
    });

    it('should grant task creation to contributor but deny project delete', () => {
      expect(
        service.hasProjectPermission(
          ProjectRole.CONTRIBUTOR,
          Permission.TASK_CREATE,
        ),
      ).toBe(true);
      expect(
        service.hasProjectPermission(
          ProjectRole.CONTRIBUTOR,
          Permission.PROJECT_DELETE,
        ),
      ).toBe(false);
    });

    it('should grant document view to project viewer', () => {
      expect(
        service.hasProjectPermission(
          ProjectRole.VIEWER,
          Permission.DOCUMENT_VIEW,
        ),
      ).toBe(true);
      expect(
        service.hasProjectPermission(
          ProjectRole.VIEWER,
          Permission.PROJECT_DELETE,
        ),
      ).toBe(false);
    });
  });

  describe('getWorkspaceMemberRole & getProjectMemberRole with Redis caching', () => {
    it('should retrieve workspace member role from cache if present', async () => {
      redis.get.mockResolvedValue('admin');
      const role = await service.getWorkspaceMemberRole('ws-1', 'user-1');
      expect(role).toBe('admin');
      expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
    });

    it('should fetch from DB and populate cache if not cached', async () => {
      redis.get.mockResolvedValue(null);
      prisma.workspaceMember.findUnique.mockResolvedValue({
        role: 'admin',
      });

      const role = await service.getWorkspaceMemberRole('ws-1', 'user-1');
      expect(role).toBe('admin');
      expect(prisma.workspaceMember.findUnique).toHaveBeenCalledWith({
        where: {
          workspaceId_userId: {
            workspaceId: 'ws-1',
            userId: 'user-1',
          },
        },
        select: { role: true },
      });
      expect(redis.set).toHaveBeenCalledWith(
        'flux:iam:ws_role:ws-1:user-1',
        'admin',
        600,
      );
    });

    it('should retrieve project member role', async () => {
      redis.get.mockResolvedValue(null);
      prisma.projectMember.findUnique.mockResolvedValue({
        role: 'contributor',
      });

      const role = await service.getProjectMemberRole('p-1', 'user-1');
      expect(role).toBe('contributor');
      expect(prisma.projectMember.findUnique).toHaveBeenCalledWith({
        where: {
          projectId_userId: {
            projectId: 'p-1',
            userId: 'user-1',
          },
        },
        select: { role: true },
      });
      expect(redis.set).toHaveBeenCalledWith(
        'flux:iam:proj_role:p-1:user-1',
        'contributor',
        600,
      );
    });

    it('should invalidate role caches on demand', async () => {
      await service.invalidateWorkspaceRoleCache('ws-1', 'user-1');
      expect(redis.del).toHaveBeenCalledWith('flux:iam:ws_role:ws-1:user-1');

      await service.invalidateProjectRoleCache('p-1', 'user-1');
      expect(redis.del).toHaveBeenCalledWith('flux:iam:proj_role:p-1:user-1');
    });
  });
});
