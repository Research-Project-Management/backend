import { Test, TestingModule } from '@nestjs/testing';
import { AuthzService } from '@/modules/iam/authz/authz.service';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { Permission } from '@/modules/iam/authz/enums/permissions.enum';
import { WorkspaceRole } from '@/modules/iam/authz/enums/workspace-role.enum';

describe('AuthorizationService (Compatibility)', () => {
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
  });

  describe('getWorkspaceMemberRole & getProjectMemberRole', () => {
    it('should retrieve workspace member role', async () => {
      redis.get.mockResolvedValue('admin');
      const role = await service.getWorkspaceMemberRole('ws-1', 'user-1');
      expect(role).toBe('admin');
    });

    it('should retrieve project member role', async () => {
      redis.get.mockResolvedValue(null);
      prisma.projectMember.findUnique.mockResolvedValue({
        role: 'contributor',
      });
      const role = await service.getProjectMemberRole('p-1', 'user-1');
      expect(role).toBe('contributor');
    });
  });
});
