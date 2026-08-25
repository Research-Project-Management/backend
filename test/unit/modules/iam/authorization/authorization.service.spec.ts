import { Test, TestingModule } from '@nestjs/testing';
import { AuthzService } from '@/modules/iam/authz/authz.service';
import { PrismaService } from '@/core/database/prisma.service';
import { Permission } from '@/modules/iam/authz/enums/permissions.enum';
import { WorkspaceRole } from '@/modules/iam/authz/enums/workspace-role.enum';
import { ProjectRole } from '@/modules/iam/authz/enums/project-role.enum';

describe('AuthzService', () => {
  let service: AuthzService;
  let prismaService: any;

  beforeEach(async () => {
    prismaService = {
      workspaceMember: {
        findFirst: jest.fn(),
      },
      projectMember: {
        findFirst: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthzService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    service = module.get<AuthzService>(AuthzService);
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
          Permission.WORKSPACE_READ,
        ),
      ).toBe(true);
    });
  });

  describe('hasProjectPermission', () => {
    it('should grant project update to project admin', () => {
      expect(
        service.hasProjectPermission(
          ProjectRole.ADMIN,
          Permission.PROJECT_UPDATE,
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

    it('should grant commenting to commenter but deny task creation', () => {
      expect(
        service.hasProjectPermission(
          ProjectRole.COMMENTER,
          Permission.COMMENT_CREATE,
        ),
      ).toBe(true);
      expect(
        service.hasProjectPermission(
          ProjectRole.COMMENTER,
          Permission.TASK_CREATE,
        ),
      ).toBe(false);
    });

    it('should grant only reading to project viewer', () => {
      expect(
        service.hasProjectPermission(
          ProjectRole.VIEWER,
          Permission.PROJECT_READ,
        ),
      ).toBe(true);
      expect(
        service.hasProjectPermission(
          ProjectRole.VIEWER,
          Permission.COMMENT_CREATE,
        ),
      ).toBe(false);
    });
  });

  describe('getWorkspaceMemberRole & getProjectMemberRole', () => {
    it('should retrieve workspace member role', async () => {
      prismaService.workspaceMember.findFirst.mockResolvedValue({
        role: 'admin',
      });
      const role = await service.getWorkspaceMemberRole('ws-1', 'user-1');
      expect(role).toBe('admin');
    });

    it('should retrieve project member role', async () => {
      prismaService.projectMember.findFirst.mockResolvedValue({
        role: 'contributor',
      });
      const role = await service.getProjectMemberRole('p-1', 'user-1');
      expect(role).toBe('contributor');
    });
  });
});
